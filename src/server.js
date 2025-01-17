"use strict";

const { log } = require("dbc-node-logger");
const { v4: uuidv4 } = require("uuid");

const createRedis = require("./clients/redis");
const initSmaug = require("./clients/smaug");
const initProxy = require("./clients/proxy");
const initPreauthenticated = require("./clients/preauthenticated");
const initFbsLogin = require("./clients/fbslogin");
const initLogger = require("./logger");
const { nanoToMs } = require("./utils");

// JSON Schema for validating the request headers
const schema = {
  headers: {
    type: "object",
    properties: {
      Authorization: { type: "string" },
    },
    required: ["Authorization"],
  },
};

/**
 * All requests to the adapter is handled in this route handler
 */
module.exports = async function (fastify, opts) {
  // Initialize and create global logger for app
  const appLogger = initLogger({ app: "fbs-cms-adapter" });
  appLogger.info("App started");

  // Prepare for 'decorateRequest' and 'timings' properties to be set on request object
  fastify.decorateRequest("requestLogger", null);
  fastify.decorateRequest("timings", null);

  // Establish connections to redis for namespaces
  const redisClientPatronId = createRedis({
    log: appLogger,
    namespace: "patronid",
  });
  const redisClientSessionKey = createRedis({
    log: appLogger,
    namespace: "sessionkey",
  });

  fastify.addHook("onRequest", (request, reply, done) => {
    // Create request logger and generate uuid (reqId) to be attached
    // to every log line during this request
    request.requestLogger = appLogger.child({ reqId: uuidv4() });

    request.requestLogger.info("onRequest", {
      requestObj: {
        method: request.method,
        url: request.url,
        headers: request.headers,
        hostname: request.hostname,
        remoteAddress: request.ip,
        remotePort: request.connection.remotePort,
      },
    });

    request.timings = { start: process.hrtime() };

    done();
  });

  fastify.addHook("onResponse", (request, reply, done) => {
    request.requestLogger.info("onResponse", {
      response: { status: reply.statusCode },
      timings: { ms: nanoToMs(process.hrtime(request.timings.start)[1]) },
    });
    done();
  });

  // route to check if server is running
  fastify.get("/", { logLevel: "silent" }, async (request) => {
    return "ok";
  });

  fastify.route({
    method: ["GET", "POST", "PUT", "DELETE"],
    url: "*",
    schema,
    logLevel: "silent",
    handler: async (request, reply) => {
      try {
        const requestLogger = request.requestLogger;

        // Initialize clients with logger for this request
        const redisPatronId = redisClientPatronId.init({
          log: requestLogger,
        });
        const redisSessionKey = redisClientSessionKey.init({
          log: requestLogger,
        });
        const smaug = initSmaug({ log: requestLogger });
        const proxy = initProxy({
          url: request.url,
          method: request.method,
          headers: request.headers,
          body: request.body,
          log: requestLogger,
        });
        const preauthenticated = initPreauthenticated({
          log: requestLogger,
          redis: redisPatronId,
        });
        const fbsLogin = initFbsLogin({
          log: requestLogger,
          redis: redisSessionKey,
        });

        // The smaug token extracted from authorization header
        const token = request.headers.authorization.replace(/bearer /i, "");

        // Check if we need to fetch patronId
        const patronIdRequired = request.url.includes("/patronid/");

        // The smaug configuration, fetched and validated
        const configuration = await smaug.fetch({
          token,
          patronIdRequired,
        });

        // We need to login and get a sessionKey in order to call the FBS API
        let sessionKey = await fbsLogin.fetch({
          token,
          configuration,
        });

        // Holds the patronId
        let patronId;

        // Holds the proxy response
        let proxyResponse;

        try {
          if (patronIdRequired) {
            patronId = await preauthenticated.fetch({
              token,
              sessionKey,
              configuration,
            });
          }

          proxyResponse = await proxy.fetch({
            sessionKey,
            patronId,
            agencyid: configuration.fbs.agencyid,
          });
        } catch (e) {
          if (e.code === 401) {
            // Calls to the FBS API may fail with 401
            // This means sessionKey is expired and we have to login again
            sessionKey = await fbsLogin.fetch({
              token,
              configuration,
              skipCache: true,
            });
            if (patronIdRequired) {
              patronId = await preauthenticated.fetch({
                token,
                sessionKey,
                configuration,
                skipCache: true,
              });
            }
            proxyResponse = await proxy.fetch({
              sessionKey,
              patronId,
              agencyid: configuration.fbs.agencyid,
            });
          } else {
            // Give up, and pass the error to the caller
            throw e;
          }
        }

        // Finally send the proxied response to the caller
        reply.code(proxyResponse.code).send(await proxyResponse.body);
      } catch (error) {
        if (!error.code) {
          // This is an unexpected error, could be a bug
          // request.log.error(error);
          log.error(String(error), {
            error: String(error),
            stacktrace: error.stack,
          });
        }

        reply
          .code(error.code || 500)
          .send(
            typeof error.body === "undefined"
              ? "internal server error"
              : error.body
          );
      }
    },
  });
};
