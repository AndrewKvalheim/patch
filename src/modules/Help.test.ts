import { expect, test } from "@jest/globals";
import Commands from "../modules/Commands";
import Help from "../modules/Help";
import Patch from "../Patch";

// TODO: Simplify
import type { Global } from "../../test/MatrixEnvironment.mjs";
declare const accessToken: Global["accessToken"];
declare const baseUrl: Global["baseUrl"];
declare const collect: Global["collect"];
declare const matrix: Global["matrix"];
declare const userId: Global["userId"];

test("view public help brief", async () => {
  const room = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", room);

  const patch = new Patch({ accessToken, baseUrl, modules: [Commands(), Help()] });
  await patch.start();
  const collected = collect(({ rooms }) =>
    rooms?.join?.[room]?.timeline?.events?.filter(
      (e: any) => e.sender === userId && !e.state_key
    )
  );
  await matrix("admin", "put", "rooms", room, "send", "m.room.message", "help-public", {
    msgtype: "m.text",
    body: "!help",
  });
  await expect(collected).resolves.toMatchObject([
    { content: { body: expect.stringContaining("Commands:") } },
  ]);
  await patch.stop();
});

test("view admin help brief", async () => {
  const room = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", room);

  const patch = new Patch({ accessToken, baseUrl, modules: [Commands(), Help()] });
  patch.controlRoom = room;
  await patch.start();
  const collected = collect(({ rooms }) =>
    rooms?.join?.[room]?.timeline?.events?.filter(
      (e: any) => e.sender === userId && !e.state_key
    )
  );
  await matrix("admin", "put", "rooms", room, "send", "m.room.message", "help-admin", {
    msgtype: "m.text",
    body: "!help",
  });
  await expect(collected).resolves.toMatchObject([
    { content: { body: expect.stringContaining("Admin commands:") } },
  ]);
  await patch.stop();
});
