import { execSync, spawn, spawnSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { TestEnvironment as NodeEnvironment } from "jest-environment-node";
import fetch from "node-fetch";
import { tmpdir } from "os";
import { join } from "path";
import { URL } from "url";

/**
 * @typedef {Object} GlobalExtension
 * @property {string} accessToken
 * @property {string} baseUrl
 * @property {string} homeserver
 * @property {string} userId
 * @property {MatrixEnvironment["admin"]} admin
 * @property {MatrixEnvironment["collect"]} collect
 * @property {MatrixEnvironment["getUserId"]} getUserId
 * @property {MatrixEnvironment["matrix"]} matrix
 *
 * @typedef {InstanceType<typeof NodeEnvironment>["global"] & GlobalExtension} Global
 */

/**
 * @typedef {Object} User
 * @property {string} accessToken
 * @property {string} userId
 */

class MatrixEnvironment extends NodeEnvironment {
  /** @type {string} */
  #adminRoom;
  /** @type {string} */
  #cid;
  /** @type {string} */
  #tmpDir;
  /** @type {Record<string, User>} */
  #users = {};

  /**
   * @param {import("@jest/environment").JestEnvironmentConfig} config
   * @param {import("@jest/environment").EnvironmentContext} context
   */
  constructor(config, context) {
    super(config, context);

    /** @type {Global} */ // Workaround for microsoft/TypeScript#26811
    this.global;

    this.global.admin = this.admin.bind(this);
    this.global.collect = this.collect.bind(this);
    this.global.getUserId = this.getUserId.bind(this);
    this.global.matrix = this.matrix.bind(this);
  }

  /** @override */
  async setup() {
    await super.setup();

    await this.#startHomeserver();

    await this.#createUser("admin");
    await this.#createUser("patch");

    this.#adminRoom = (
      await this.matrix("admin", "get", "directory", "room", "#admins:localhost")
    ).room_id;
    this.global.userId = this.#users["patch"].userId;
    this.global.accessToken = this.#users["patch"].accessToken;
  }

  /** @override */
  async teardown() {
    await this.admin(`deactivate-user --leave-rooms ${this.global.userId}`);
    await this.#stopHomeserver();
    await super.teardown();
  }

  /**
   * @param {string} command
   * @returns {Promise<void>}
   */
  async admin(command) {
    await this.matrix(
      "admin",
      "put",
      "rooms",
      this.#adminRoom,
      "send",
      "m.room.message",
      new Date().valueOf(),
      { msgtype: "m.message", body: `@conduit:${this.global.homeserver}: ${command}` }
    );
  }

  /**
   * @template T
   * @param {(sync: any) => T} query
   * @param {(collected: T[], sync: any) => boolean} [until]
   * @returns {Promise<T[]>}
   */
  collect(query, until = (c) => c.length) {
    const collected = [];
    const typing = new Set();

    return new Promise(async (resolve) => {
      for await (const sync of this.sync()) {
        if (!sync) return resolve(collected);
        collected.push(...(query(sync) ?? []));
        for (const [room, { ephemeral }] of Object.entries(sync.rooms?.join ?? {})) {
          const typers = ephemeral?.events
            ?.filter((e) => e.type === "m.typing")
            .flatMap((e) => e.content.user_ids);

          if (typers)
            if (typers.length) typing.add(room);
            else typing.delete(room);
        }
        if (!typing.size && until(collected, sync)) return resolve(collected);
      }
    });
  }

  /**
   * @param {string} username
   * @returns {Promise<string>}
   */
  async getUserId(username) {
    if (!(username in this.#users)) await this.#createUser(username);

    return this.#users[username].userId;
  }

  /**
   * @param {string} username;
   * @param {NonNullable<import("node-fetch").RequestInit["method"]>} method;
   * @param {...(Parameters<encodeURIComponent>[0] | object)} parts;
   * @returns {Promise<any>}
   */
  async matrix(username, method, ...parts) {
    const body = typeof parts.slice(-1)[0] === "object" ? parts.pop() : undefined;
    const path = parts.map(encodeURIComponent).join("/");
    const response = await fetch(`${this.global.baseUrl}/_matrix/client/v3/${path}`, {
      headers: {
        authorization: `Bearer ${this.#users[username].accessToken}`,
        ...(body && { "content-type": "application/json" }),
      },
      method,
      ...(body && { body: JSON.stringify(body) }),
    });

    if (response.ok) return await response.json();
    else {
      const status = `${response.status} ${response.statusText}`;
      console.error(`${username} ${method} ${path} ${JSON.stringify(body)}`);
      throw new Error(`${status} ${await response.text()}`);
    }
  }

  async *sync() {
    // Filters pending famedly/conduit#6
    const url = new URL("_matrix/client/v3/sync?timeout=1000", this.global.baseUrl);
    const init = {
      headers: { authorization: `Bearer ${this.#users["admin"].accessToken}` },
    };

    while (true) {
      try {
        const response = await fetch(url, init);
        const sync = await response.json();
        // console.log(url.toString(), "→", JSON.stringify(sync, undefined, 2));
        url.searchParams.set("since", sync.next_batch);
        yield sync;
      } catch (error) {
        if (!this.#cid && error.code === "ECONNREFUSED") return;
        else throw error;
      }
    }
  }

  /**
   * @param {string} username
   * @returns {Promise<void>} */
  async #createUser(username) {
    const response = await (
      await fetch(`${this.global.baseUrl}/_matrix/client/v3/register?kind=user`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ auth: { type: "m.login.dummy" }, username }),
      })
    ).json();

    this.#users[username] = {
      accessToken: response.access_token,
      userId: response.user_id,
    };

    await this.matrix(username, "put", "profile", response.user_id, "displayname", {
      displayname: username,
    });
  }

  async #startHomeserver() {
    this.#tmpDir = mkdtempSync(join(tmpdir(), "homeserver-"));
    const cidPath = join(this.#tmpDir, "cid");

    const homeserver = spawn("podman", [
      "run",
      "--rm",
      `--cidfile=${cidPath}`,
      "--tmpfs=/var/lib/matrix-conduit",
      "--publish=6167",
      "--env=CONDUIT_SERVER_NAME=localhost",
      "--env=CONDUIT_ALLOW_FEDERATION=false",
      "--env=CONDUIT_ALLOW_REGISTRATION=true",
      "matrixconduit/matrix-conduit:v0.5.0",
    ]);

    await new Promise((resolve) => {
      homeserver.stdout.on("data", (data) => {
        if (data.includes("Created new sqlite database")) resolve(undefined);
      });
    });
    homeserver.unref();

    this.#cid = readFileSync(cidPath, { encoding: "utf8" });
    const port = execSync(
      `podman inspect --format='{{ (index (index .NetworkSettings.Ports "6167/tcp") 0).HostPort }}' ${
        this.#cid
      }`
    );

    this.global.baseUrl = `http://localhost:${port}`;
    this.global.homeserver = "localhost";
  }

  async #stopHomeserver() {
    spawnSync("podman", ["kill", this.#cid]);
    rmSync(this.#tmpDir, { force: true, recursive: true });
    this.#cid = undefined;
  }
}

export default MatrixEnvironment;
