import { expect, test } from "@jest/globals";
import Module from "./lib/Module";
import Patch from "./Patch";

// TODO: Simplify
import type { Global } from "../test/MatrixEnvironment.mjs";
declare const accessToken: Global["accessToken"];
declare const admin: Global["admin"];
declare const baseUrl: Global["baseUrl"];
declare const matrix: Global["matrix"];
declare const userId: Global["userId"];

test("initial sync", async () => {
  // Populate example room
  const expected = [...Array(1000).keys()].map((i) => `marker-${i}`);
  const room = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await Promise.all(
    expected.map((key) => matrix("admin", "put", "rooms", room, "state", "📍", key, {}))
  );
  await matrix("patch", "post", "join", room);

  // Gather initial state
  let actual: typeof expected;
  const Inspect = class extends Module {
    async start() {
      await admin(`deactivate-user ${userId}`); // Guarantee use of cache
      actual = (await this.matrix.getRoomState(room))
        .filter((e) => e.type === "📍")
        .map((e) => e.state_key);
    }
    async stop() {}
  };
  const patch = new Patch({ accessToken, baseUrl, modules: [Inspect] });
  await patch.start();
  await patch.stop();

  expect(actual!).toEqual(expect.arrayContaining(expected));
});

test.todo("relay errors to control room");
