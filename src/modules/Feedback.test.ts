import { expect, jest, test } from "@jest/globals";
import Feedback from "../modules/Feedback";
import Patch from "../Patch";

// TODO: Simplify
import type { Global } from "../../test/MatrixEnvironment.mjs";
declare const accessToken: Global["accessToken"];
declare const baseUrl: Global["baseUrl"];
declare const collect: Global["collect"];
declare const getUserId: Global["getUserId"];
declare const matrix: Global["matrix"];
declare const userId: Global["userId"];

test("good bot", async () => {
  const room = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", room);

  const patch = new Patch({ accessToken, baseUrl, modules: [Feedback()] });
  await patch.start();
  const collected = collect(({ rooms }) =>
    rooms?.join?.[room]?.timeline?.events?.filter(
      (e: any) => e.sender === userId && !e.state_key
    )
  );
  await matrix("admin", "put", "rooms", room, "send", "m.room.message", "good-bot", {
    msgtype: "m.text",
    body: "Good bot. ❤️",
  });
  await expect(collected).resolves.toMatchObject([
    { content: { "m.relates_to": { rel_type: "m.annotation", key: "🤖" } } },
  ]);
  await patch.stop();
});

test("bad bot", async () => {
  const controlRoom = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", controlRoom);
  const publicRoom = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", publicRoom);

  const patch = new Patch({ accessToken, baseUrl, modules: [Feedback()] });
  patch.controlRoom = controlRoom;

  await patch.start();
  const collected = collect(({ rooms }) =>
    rooms?.join?.[controlRoom]?.timeline?.events?.filter(
      (e: any) => e.sender === userId && !e.state_key
    )
  );
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  await matrix("admin", "put", "rooms", publicRoom, "send", "m.room.message", "bad-bot", {
    msgtype: "m.text",
    body: "Bad bot!",
  });
  const message = expect.stringContaining("Negative feedback");
  await expect(collected).resolves.toMatchObject([{ content: { body: message } }]);
  expect(warn).toHaveBeenCalledWith("Patch", message, expect.anything());
  await patch.stop();
});

// Pending Conduit support for syncing m.room.member leave event
// https://matrix.to/#/!SMloEYlhCiqKwRLAgY:fachschaften.org/$Ofdux1PHUxXcU99uhFdbEug7sk_p4Pquwzfwj5aWj3E?via=matrix.org
test.skip("kicked", async () => {
  const controlRoom = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", controlRoom);
  const publicRoom = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", publicRoom);

  const patch = new Patch({ accessToken, baseUrl, modules: [Feedback()] });
  patch.controlRoom = controlRoom;

  await patch.start();
  const collected = collect(({ rooms }) =>
    rooms?.join?.[controlRoom]?.timeline?.events?.filter(
      (e: any) => e.sender === userId && !e.state_key
    )
  );
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  await matrix("admin", "post", "rooms", publicRoom, "kick", {
    user_id: userId,
    reason: "No birds allowed",
  });
  const message = expect.stringContaining("Got kicked");
  await expect(collected).resolves.toMatchObject([{ content: { body: message } }]);
  expect(warn).toHaveBeenCalledWith("Patch", message, expect.anything());
  await patch.stop();
});
