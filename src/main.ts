import * as Sentry from "@sentry/node";
import "@sentry/tracing";
import { release } from "./lib/version";
Sentry.init({ release });

import { readFileSync } from "fs";
import { Settings } from "luxon";
import { LogLevel, LogService } from "matrix-bot-sdk";
import Logger from "./lib/Logger";
import Announce from "./modules/Announce";
import Commands from "./modules/Commands";
import Concierge from "./modules/Concierge";
import Feedback from "./modules/Feedback";
import Help from "./modules/Help";
import ReadReceipts from "./modules/ReadReceipts";
import Reconciler from "./modules/Reconciler";
import Tea from "./modules/Tea";
import Patch from "./Patch";
import { parsePlan } from "./lib/Plan";
import { env } from "./lib/utilities";

const plan = parsePlan(readFileSync("data/plan.yml", { encoding: "utf8" }));

Settings.defaultZone = plan.timeZone;

LogService.setLogger(new Logger({ MatrixClientLite: LogLevel.INFO }));
LogService.setLevel(LogLevel.fromString(process.env["LOG_LEVEL"]!));
LogService.muteModule("MatrixHttpClient");
LogService.muteModule("Metrics");

const config = {
  accessToken: env("MATRIX_ACCESS_TOKEN"),
  baseUrl: env("MATRIX_BASE_URL"),
  id: plan.steward.id,
  modules: [
    Announce(),
    Commands(),
    Concierge(),
    Feedback(),
    Help(),
    ReadReceipts(),
    Reconciler(plan),
    Tea(),
  ],
  statePath: "state/state.json",
};

await new Patch(config).start();
