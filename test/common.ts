import { beforeAll } from "@jest/globals";
import { LogLevel, LogService } from "matrix-bot-sdk";

beforeAll(() => {
  LogService.setLevel(LogLevel.WARN);
  LogService.muteModule("MatrixClientLite");
  LogService.muteModule("MatrixHttpClient");
});
