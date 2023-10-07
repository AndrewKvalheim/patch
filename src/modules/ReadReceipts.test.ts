import { expect, test } from "@jest/globals";
import ReadReceipts from "../modules/ReadReceipts";
import Patch from "../Patch";

// TODO: Simplify
import type { Global } from "../../test/MatrixEnvironment.mjs";
declare const accessToken: Global["accessToken"];
declare const baseUrl: Global["baseUrl"];
declare const collect: Global["collect"];
declare const matrix: Global["matrix"];
declare const userId: Global["userId"];

test("send read receipt", async () => {
  const room = (await matrix("admin", "post", "createRoom", { invite: [userId] }))
    .room_id;
  await matrix("patch", "post", "join", room);

  const patch = new Patch({ accessToken, baseUrl, modules: [ReadReceipts()] });
  await patch.start();
  const collected = collect(({ rooms }) =>
    rooms?.join?.[room]?.ephemeral?.events?.filter((e: any) => e.type === "m.receipt")
  );
  await matrix("admin", "put", "rooms", room, "send", "m.room.message", "readme", {
    msgtype: "m.text",
    body: "SYN",
  });
  await expect(collected).resolves.toMatchObject([{ type: "m.receipt" }]);
  await patch.stop();
});
