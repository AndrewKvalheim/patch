import type Client from "./Client";
import type Patch from "../Patch";

export default abstract class Module {
  protected trace: Patch["trace"];
  protected debug: Patch["debug"];
  protected info: Patch["info"];
  protected warn: Patch["warn"];
  protected error: Patch["error"];

  constructor(protected readonly patch: Patch, protected readonly matrix: Client) {
    this.trace = patch.trace.bind(patch);
    this.debug = patch.debug.bind(patch);
    this.info = patch.info.bind(patch);
    this.warn = patch.warn.bind(patch);
    this.error = patch.error.bind(patch);
  }

  public abstract start(): Promise<void>;
  public abstract stop(): Promise<void>;
}
