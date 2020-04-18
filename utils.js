const config = require("config");
const dict = require("dicom-data-dictionary");
const dimse = require("dicom-dimse-native");
const winston = require("winston");
const storage = require("node-persist");
const path = require("path");
const fs = require("fs");

require("winston-daily-rotate-file");

const lock = new Map();

const dailyRotateFile = new winston.transports.DailyRotateFile({
  filename: `${config.get("logDir")}/app-%DATE%.log`, // last part is the filename suffix
  datePattern: "YYYY-MM-DD-HH",
  zippedArchive: true,
  maxSize: "20m",
  maxFiles: "14d",
});

const consoleLogger = new winston.transports.Console();

const logger = new winston.Logger({
  transports: [dailyRotateFile, consoleLogger],
});

const findDicomName = name => {
  for (const key of Object.keys(dict.standardDataElements)) {
    const value = dict.standardDataElements[key];
    if (value.name == name) {
      return key;
    }
  }
};

// helper to add minutes to date object
const addMinutes = (date, minutes) => {
  return new Date(date.getTime() + minutes * 60000);
};

// request data from PACS via c-get or c-move
const fetchData = async (studyUid, seriesUid, waitForFirstImageOnly) => {
  // add query retrieve level and fetch whole study
  const j = {
    tags: [
      {
        key: "00080052",
        value: "SERIES",
      },
      {
        key: "0020000D",
        value: studyUid,
      },
      {
        key: "0020000E",
        value: seriesUid,
      },
    ],
  };

  // set source and target from config
  j.source = config.get("source");
  j.target = config.get("target");
  j.storagePath = config.get("storagePath");

  const scu = config.get("useCget") ? dimse.getScu : dimse.moveScu;

  const prom = new Promise((resolve, reject) => {
    try {
      scu(JSON.stringify(j), result => {
        try {
          const json = JSON.parse(result);
          if (
            waitForFirstImageOnly &&
            json.code === 1 &&
            json.container.SOPInstanceUID
          ) {
            logger.info(
              "stored",
              path.join(j.storagePath, studyUid, json.container.SOPInstanceUID)
            );
            resolve(json);
          } else if (json.code === 0 || json.code === 2) {
            storage.getItem(studyUid).then(item => {
              if (!item) {
                logger.info("stored", path.join(j.storagePath, studyUid));
                const cacheTime = config.get("keepCacheInMinutes");
                if (cacheTime >= 0) {
                  storage.setItem(studyUid, addMinutes(new Date(), cacheTime));
                }
              }
            });
            resolve(json);
          } else {
            logger.info(JSON.parse(result));
          }
        } catch (error) {
          reject(error, result);
        }
        lock.delete(seriesUid);
      });
    } catch (error) {
      reject(error);
    }
  });
  // store in lock
  lock.set(seriesUid, prom);
  return prom;
};

const utils = {
  getLogger: () => {
    return logger;
  },

  init: async () => {
    await storage.init();
  },

  startScp: () => {
    let j = {};
    j.source = config.get("source");
    j.storagePath = config.get("storagePath");

    dimse.startScp(JSON.stringify(j), result => {
      try {
        logger.info(JSON.parse(result));
      } catch (error) {
        logger.error(error, result);
      }
    });
  },

  sendEcho: () => {
    let j = {};
    j.source = config.get("source");
    j.target = config.get("target");

    logger.info(`sending C-ECHO to target: ${j.target.aet}`);
    dimse.echoScu(JSON.stringify(j), result => {
      try {
        logger.info(JSON.parse(result));
      } catch (error) {
        logger.error(result);
      }
    });
  },

  // fetch and wait
  waitOrFetchData: (studyUid, seriesUid, waitForFirstImageOnly) => {
    // check if already locked and return promise
    if (lock.has(seriesUid)) {
      return lock.get(seriesUid);
    }
    return fetchData(studyUid, seriesUid, waitForFirstImageOnly);
  },

  // remove cached data if outdated
  clearCache: async (storagePath, currentUid) => {
    const currentDate = new Date();
    storage.forEach(item => {
      const dt = new Date(item.value);
      const directory = path.join(storagePath, item.key);
      if (dt.getTime() < currentDate.getTime() && item.key !== currentUid) {
        fs.rmdir(
          directory,
          {
            recursive: true,
          },
          error => {
            if (error) {
              logger.error(error);
            } else {
              logger.info("deleted", directory);
              storage.rm(item.key); // not nice but seems to work
            }
          }
        );
      }
    });
  },

  fileExists: pathname => {
    return new Promise((resolve, reject) => {
      fs.access(pathname, err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  },

  doFind: (queryLevel, query, defaults) => {
    // add query retrieve level
    const j = {
      tags: [
        {
          key: "00080052",
          value: queryLevel,
        },
      ],
    };

    // set source and target from config
    j.source = config.get("source");
    j.target = config.get("target");

    // parse all include fields
    const includes = query.includefield;

    let tags = [];
    if (includes) {
      tags = includes.split(",");
    }
    tags.push(...defaults);

    // add parsed tags
    tags.forEach(element => {
      const tagName = findDicomName(element) || element;
      j.tags.push({ key: tagName, value: "" });
    });

    // add search params
    for (const propName in query) {
      if (query.hasOwnProperty(propName)) {
        const tag = findDicomName(propName);
        if (tag) {
          let v = query[propName];
          // patient name check
          if (tag === "00100010") {
            // min chars
            if (config.get("qidoMinChars") > v.length) {
              return [];
            }
            // auto append wildcard
            if (config.get("qidoAppendWildcard")) {
              v += "*";
            }
          }
          j.tags.push({ key: tag, value: v });
        }
      }
    }

    const offset = query.offset ? parseInt(query.offset) : 0;

    // run find scu and return json response
    return new Promise((resolve, reject) => {
      dimse.findScu(JSON.stringify(j), result => {
        try {
          const j = JSON.parse(result);
          if (j.code === 0) {
            const container = JSON.parse(j.container);
            if (container) {
              resolve(container.slice(offset));
            } else {
              resolve([]);
            }
          }
        } catch (error) {
          logger.error(error);
          logger.error(result);
          resolve([]);
        }
      });
    });
  },
};
module.exports = utils;
