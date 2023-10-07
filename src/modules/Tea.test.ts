import { expect, test } from "@jest/globals";
import Commands from "../modules/Commands";
import Tea from "../modules/Tea";
import Patch from "../Patch";

// TODO: Simplify
import type { Global } from "../../test/MatrixEnvironment.mjs";
declare const accessToken: Global["accessToken"];
declare const baseUrl: Global["baseUrl"];
declare const collect: Global["collect"];
declare const getUserId: Global["getUserId"];
declare const matrix: Global["matrix"];
declare const userId: Global["userId"];

test("undirected toast", async () => {
  const room = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", room);

  const patch = new Patch({ accessToken, baseUrl, modules: [Commands(), Tea()] });
  await patch.start();
  const collected = collect(({ rooms }) =>
    rooms?.join?.[room]?.timeline?.events?.filter(
      (e: any) => e.sender === userId && !e.state_key
    )
  );
  await matrix("admin", "put", "rooms", room, "send", "m.room.message", "tea", {
    msgtype: "m.text",
    body: "!tea",
  });
  await expect(collected).resolves.toMatchObject([
    { content: { body: expect.stringMatching(/“.+”/) } },
  ]);
  await patch.stop();
});

test("toast a user via plain text", async () => {
  const other = await getUserId("other");
  const room = (await matrix("admin", "post", "createRoom", { invite: [userId, other] }))
    .room_id;
  await matrix("other", "post", "join", room);
  await matrix("patch", "post", "join", room);

  const patch = new Patch({ accessToken, baseUrl, modules: [Commands(), Tea()] });
  await patch.start();
  const collected = collect(({ rooms }) =>
    rooms?.join?.[room]?.timeline?.events?.filter(
      (e: any) => e.sender === userId && !e.state_key
    )
  );
  await matrix(
    "admin",
    "put",
    "rooms",
    room,
    "send",
    "m.room.message",
    "tea-other-text",
    {
      msgtype: "m.text",
      body: `!tea ${other}`,
    }
  );
  await expect(collected).resolves.toMatchObject([
    {
      content: {
        body: expect.stringMatching(/other \[.+\]: admin \[.+\] is toasting you! “.+”/),
      },
    },
  ]);
  await patch.stop();
});

test("toast a user via HTML", async () => {
  const other = await getUserId("other");
  const room = (await matrix("admin", "post", "createRoom", { invite: [userId, other] }))
    .room_id;
  await matrix("other", "post", "join", room);
  await matrix("patch", "post", "join", room);

  const patch = new Patch({ accessToken, baseUrl, modules: [Commands(), Tea()] });
  await patch.start();
  const collected = collect(({ rooms }) =>
    rooms?.join?.[room]?.timeline?.events?.filter(
      (e: any) => e.sender === userId && !e.state_key
    )
  );
  await matrix(
    "admin",
    "put",
    "rooms",
    room,
    "send",
    "m.room.message",
    "tea-other-html",
    {
      msgtype: "m.text",
      format: "org.matrix.custom.html",
      formatted_body: `!tea <a href="https://matrix.to/#/${other}">other</a>`,
      body: `!tea ${other}`,
    }
  );
  await expect(collected).resolves.toMatchObject([
    {
      content: {
        formatted_body: expect.stringMatching(
          /<a href=".+">other<\/a>: <a href=".+">admin<\/a> is toasting you! <em>“.+”<\/em>/
        ),
      },
    },
  ]);
  await patch.stop();
});
