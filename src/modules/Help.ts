import type { Handler } from "../modules/Commands";
import Module from "../lib/Module";

export default () =>
  class Help extends Module {
    public async start() {
      this.patch.on("command.admin.help", this.helpControlRoom);
      this.patch.on("command.public.help", this.helpPublic);
    }

    public async stop() {
      this.patch.off("command.admin.help", this.helpControlRoom);
      this.patch.off("command.public.help", this.helpPublic);
    }

    private helpControlRoom: Handler = async ({ docs, event, room }) => {
      await this.matrix.replyHtmlNotice(room, event, docs.controlBrief);
    };

    private helpPublic: Handler = async ({ docs, event, room }) => {
      await this.matrix.replyHtmlNotice(room, event, docs.brief);
    };
  };
