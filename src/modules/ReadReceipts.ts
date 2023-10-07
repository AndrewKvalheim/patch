import Module from "../lib/Module";

export default () =>
  class ReadReceipts extends Module {
    public async start() {
      this.patch.on("readable", async (room, { event_id: id, sender }) => {
        this.debug("🧾 Send read receipt", { room, event: id, sender });
        await this.matrix.sendReadReceipt(room, id);
      });
    }

    public async stop() {}
  };
