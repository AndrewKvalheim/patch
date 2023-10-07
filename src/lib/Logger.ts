import chalk from "chalk";
import { DateTime } from "luxon";
import { ILogger, LogLevel } from "matrix-bot-sdk";
import { inspect } from "util";
import { optional } from "./utilities";

const oneLine = { breakLength: Infinity, compact: true };

export default class Logger implements ILogger {
  constructor(readonly overrides: Record<string, LogLevel> = {}) {}

  public trace = this.#handler(LogLevel.TRACE, console.trace, chalk.dim);
  public debug = this.#handler(LogLevel.DEBUG, console.debug, chalk.dim);
  public error = this.#handler(LogLevel.ERROR, console.error, chalk.red);
  public info = this.#handler(LogLevel.INFO, console.info, chalk.reset);
  public warn = this.#handler(LogLevel.WARN, console.warn, chalk.yellow);

  #handler(level: LogLevel, log: typeof console.log, color: chalk.ChalkFunction) {
    return <D>(module: string, message: string, data?: D) => {
      const override = this.overrides[module];
      if (override && !override.includes(level)) return;

      const timestamp = DateTime.now().toISO();
      const inspection = data && chalk.dim(inspect(data, oneLine));

      log(color(timestamp), color(message), ...optional(inspection));
    };
  }
}
