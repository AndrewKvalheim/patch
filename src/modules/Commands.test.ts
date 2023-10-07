import { expect, jest, test } from "@jest/globals";
import Module from "../lib/Module";
import Commands, { Handler } from "../modules/Commands";
import ReadReceipts from "../modules/ReadReceipts";
import Patch from "../Patch";

// TODO: Simplify
declare module "expect" {
  interface Matchers<R = void> extends CustomMatchers<R> {}
}
import type { Global } from "../../test/MatrixEnvironment.mjs";
declare const accessToken: Global["accessToken"];
declare const baseUrl: Global["baseUrl"];
declare const collect: Global["collect"];
declare const matrix: Global["matrix"];
declare const userId: Global["userId"];

class Shout extends Module {
  start = async () => void this.patch.on("command.public.shout", this.shout);
  stop = async () => void this.patch.off("command.public.shout", this.shout);
  private shout: Handler = async ({ event, input, room }) => {
    if (input.html)
      await this.matrix.replyHtmlNotice(room, event, input.html.toUpperCase());
    else if (input.text)
      await this.matrix.replyNotice(room, event, input.text.toUpperCase());
  };
}

test("nonexistent command", async () => {
  const room = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", room);

  const patch = new Patch({
    accessToken,
    baseUrl,
    modules: [ReadReceipts(), Commands()],
  });
  await patch.start();
  const collected = collect(
    ({ rooms }) =>
      rooms?.join?.[room]?.timeline?.events?.filter(
        (e: any) => e.sender === userId && !e.state_key
      ),
    (_, { rooms }) =>
      rooms?.join?.[room]?.ephemeral?.events?.some((e: any) => e.type === "m.receipt")
  );
  await matrix("admin", "put", "rooms", room, "send", "m.room.message", "readme", {
    msgtype: "m.text",
    body: "!cowsay moo",
  });
  await expect(collected).resolves.toBeEmpty();
  await patch.stop();
});

test("plain text command", async () => {
  const room = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", room);

  const patch = new Patch({ accessToken, baseUrl, modules: [Commands(), Shout] });
  await patch.start();
  const collected = collect(({ rooms }) =>
    rooms?.join?.[room]?.timeline?.events?.filter(
      (e: any) => e.sender === userId && !e.state_key
    )
  );
  await matrix("admin", "put", "rooms", room, "send", "m.room.message", "plaintext", {
    msgtype: "m.text",
    body: "!shout we get signal!",
  });
  await expect(collected).resolves.toMatchObject([
    { content: { body: expect.stringContaining("WE GET SIGNAL!") } },
  ]);
  await patch.stop();
});

test("HTML command", async () => {
  const room = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", room);

  const patch = new Patch({ accessToken, baseUrl, modules: [Commands(), Shout] });
  await patch.start();
  const collected = collect(({ rooms }) =>
    rooms?.join?.[room]?.timeline?.events?.filter(
      (e: any) => e.sender === userId && !e.state_key
    )
  );
  await matrix("admin", "put", "rooms", room, "send", "m.room.message", "html", {
    msgtype: "m.text",
    format: "org.matrix.custom.html",
    formatted_body: "!shout <strong>bold</strong> move.",
    body: "!shout **bold** move.",
  });
  await expect(collected).resolves.toMatchObject([
    {
      content: { formatted_body: expect.stringContaining("<STRONG>BOLD</STRONG> MOVE.") },
    },
  ]);
  await patch.stop();
});

test("inconsistent multipart command", async () => {
  const room = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", room);

  const patch = new Patch({
    accessToken,
    baseUrl,
    modules: [ReadReceipts(), Commands(), Shout],
  });
  await patch.start();
  const collected = collect(
    ({ rooms }) =>
      rooms?.join?.[room]?.timeline?.events?.filter(
        (e: any) => e.sender === userId && !e.state_key
      ),
    (_, { rooms }) =>
      rooms?.join?.[room]?.ephemeral?.events?.some((e: any) => e.type === "m.receipt")
  );
  const error = jest.spyOn(console, "error").mockImplementation(() => {});
  await matrix("admin", "put", "rooms", room, "send", "m.room.message", "inconsistent", {
    msgtype: "m.text",
    format: "org.matrix.custom.html",
    formatted_body: "!whisper HEY",
    body: "!shout hey",
  });
  await expect(collected).resolves.toEqual([]);
  expect(error).toHaveBeenCalledWith(
    "Patch",
    expect.stringContaining("Conflict"),
    expect.anything()
  );
  await patch.stop();
});
