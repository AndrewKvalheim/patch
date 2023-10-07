import { expect, test } from "@jest/globals";
import Announce from "../modules/Announce";
import Commands from "../modules/Commands";
import Patch from "../Patch";

// TODO: Simplify
import type { Global } from "../../test/MatrixEnvironment.mjs";
declare const accessToken: Global["accessToken"];
declare const baseUrl: Global["baseUrl"];
declare const collect: Global["collect"];
declare const getUserId: Global["getUserId"];
declare const matrix: Global["matrix"];
declare const userId: Global["userId"];

test("cancel announcement", async () => {
  const controlRoom = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", controlRoom);
  const publicRoom = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", publicRoom);

  const patch = new Patch({ accessToken, baseUrl, modules: [Commands(), Announce()] });
  patch.controlRoom = controlRoom;
  await patch.start();

  // Prompt
  const prompt = collect(
    ({ rooms }) =>
      rooms?.join?.[controlRoom]?.timeline?.events?.filter(
        (e: any) => e.sender === userId && !e.state_key
      ),
    (e) => e.length >= 3
  );
  await matrix(
    "admin",
    "put",
    "rooms",
    controlRoom,
    "send",
    "m.room.message",
    "announce-cancelled",
    {
      msgtype: "m.text",
      format: "org.matrix.custom.html",
      formatted_body: `!announce <a href="https://matrix.to/#/${publicRoom}">Room</a>: Hello world!`,
      body: `!announce ${publicRoom}: Hello world!`,
    }
  );
  await expect(prompt).resolves.toMatchObject([
    {
      content: {
        formatted_body: expect.stringContaining("<strong>Message:</strong> Hello world!"),
      },
    },
    { content: { "m.relates_to": { key: "Send", rel_type: "m.annotation" } } },
    { content: { "m.relates_to": { key: "Cancel", rel_type: "m.annotation" } } },
  ]);
  const promptId = (await prompt).find((e) => e.type === "m.room.message").event_id;

  // Cancel
  const cancellation = collect(
    ({ rooms }) =>
      rooms?.join?.[controlRoom]?.timeline?.events?.filter(
        (e: any) =>
          e.sender === userId &&
          !e.state_key &&
          (e.type === "m.room.redaction" ||
            e.content?.["m.relates_to"]?.rel_type === "m.replace")
      ),
    (e) => e.length >= 2
  );
  await matrix("admin", "put", "rooms", controlRoom, "send", "m.reaction", "cancel", {
    "m.relates_to": { event_id: promptId, rel_type: "m.annotation", key: "Cancel" },
  });
  await expect(cancellation).resolves.toMatchObject([
    { type: "m.room.redaction" },
    { type: "m.room.redaction" },
    {
      content: {
        formatted_body: expect.stringContaining("Cancelled"),
      },
    },
  ]);

  await patch.stop();
});

test("send announcement", async () => {
  const controlRoom = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", controlRoom);
  const publicRoom = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", publicRoom);

  const patch = new Patch({ accessToken, baseUrl, modules: [Commands(), Announce()] });
  patch.controlRoom = controlRoom;
  await patch.start();

  // Prompt
  const prompt = collect(
    ({ rooms }) =>
      rooms?.join?.[controlRoom]?.timeline?.events?.filter(
        (e: any) => e.sender === userId && !e.state_key
      ),
    (e) => e.length >= 3
  );
  await matrix(
    "admin",
    "put",
    "rooms",
    controlRoom,
    "send",
    "m.room.message",
    "announce-sent",
    {
      msgtype: "m.text",
      format: "org.matrix.custom.html",
      formatted_body: `!announce <a href="https://matrix.to/#/${publicRoom}">Room</a>: Hello world!`,
      body: `!announce ${publicRoom}: Hello world!`,
    }
  );
  await expect(prompt).resolves.toMatchObject([
    {
      content: {
        formatted_body: expect.stringContaining("<strong>Message:</strong> Hello world!"),
      },
    },
    { content: { "m.relates_to": { key: "Send", rel_type: "m.annotation" } } },
    { content: { "m.relates_to": { key: "Cancel", rel_type: "m.annotation" } } },
  ]);
  const promptId = (await prompt).find((e) => e.type === "m.room.message").event_id;

  // Send
  const announcement = collect(({ rooms }) =>
    rooms?.join?.[publicRoom]?.timeline?.events?.filter(
      (e: any) => e.sender === userId && !e.state_key
    )
  );
  const confirmation = collect(
    ({ rooms }) =>
      rooms?.join?.[controlRoom]?.timeline?.events?.filter(
        (e: any) =>
          e.sender === userId &&
          !e.state_key &&
          (e.type === "m.room.redaction" ||
            e.content?.["m.relates_to"]?.rel_type === "m.replace")
      ),
    (e) => e.length >= 2
  );
  await matrix("admin", "put", "rooms", controlRoom, "send", "m.reaction", "send", {
    "m.relates_to": { event_id: promptId, rel_type: "m.annotation", key: "Send" },
  });
  await expect(confirmation).resolves.toMatchObject([
    { type: "m.room.redaction" },
    { type: "m.room.redaction" },
    {
      content: {
        formatted_body: expect.stringContaining("Sent"),
      },
    },
  ]);
  await expect(announcement).resolves.toMatchObject([
    { content: { formatted_body: expect.stringContaining("Hello world!") } },
  ]);

  await patch.stop();
});
