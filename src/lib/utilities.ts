import { readFileSync } from "fs";
export { default as escapeHtml } from "lodash.escape";
import { DEFAULT_SCHEMA, load, Type } from "js-yaml";
import MarkdownIt from "markdown-it";
import _fetch from "node-fetch"; // Pending DefinitelyTyped/DefinitelyTyped#60924
import { userAgent } from "./version";

const md = new MarkdownIt();
const schema = DEFAULT_SCHEMA.extend([
  new Type("!md", {
    kind: "scalar",
    construct: (m) => md[m.includes("\n") ? "render" : "renderInline"](m),
  }),
]);

export const env = (key: string): string =>
  expect(process.env[key], `environment variable ${key}`);

export const expect = <V>(value: V | null | undefined, as = "value"): V => {
  if (!present(value)) throw new Error(`Missing ${as}`);

  return value;
};

export const fetch: typeof _fetch = (url, { headers, ...init } = {}) =>
  _fetch(url, { headers: { "user-agent": userAgent, ...headers }, ...init });

export const identity = <V>(value: V): V => value;

export const importYaml = (path: string): unknown =>
  load(readFileSync(path, { encoding: "utf-8" }), { schema });

export const maxDelay = 2147483647; // Approximately 25 days

export const optional = <V>(value: V | null | undefined): V[] =>
  present(value) ? [value] : [];

export const present = <V>(value: V | null | undefined): value is V =>
  value !== null && value !== undefined;

export const sample = <T>(items: T[]): T | undefined =>
  items[Math.floor(Math.random() * items.length)];

export const unimplemented = (subject: unknown): never => {
  throw new Error(`Not implemented for ${JSON.stringify(subject)}`);
};
