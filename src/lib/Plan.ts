import { load } from "js-yaml";
import type { PowerLevelsEventContent as PowerLevels } from "matrix-bot-sdk";
import { assertEquals } from "typia";

export type SessionGroupId = "CURRENT_SESSIONS" | "FUTURE_SESSIONS" | "PAST_SESSIONS";

export namespace Plan {
  export type InheritUserPowerLevels = Record<string, { raiseTo?: number }>;

  export interface Room {
    avatar?: string;
    children?: Rooms | SessionGroupId;
    control?: boolean;
    destroy?: boolean;
    intro?: string;
    name: string;
    private?: boolean;
    readOnly?: boolean;
    redirect?: string;
    suggested?: boolean;
    tag?: string;
    topic?: string;
    widget?: Widget;
  }

  export type Rooms = Record<string, Room>;

  export interface Sessions {
    conference: string;
    demo?: string;
    ignore?: string[];
    intro?: string;
    openEarly: number;
    prefix: string;
    redirects?: Record<string, string>;
    suffixes?: Record<string, string>;
    topic?: string;
    widgets?: Record<string, { [day: number]: Widget }>;
  }

  type Widget = { avatar?: string; name?: string } & (
    | { custom: string }
    | { jitsi: { id: string; name: string } }
  );
}

export type Plan = {
  avatars?: Record<string, string>;
  defaultRoomVersion: string;
  homeserver: string;
  inheritUserPowerLevels?: Plan.InheritUserPowerLevels;
  jitsiDomain?: string;
  powerLevels: PowerLevels;
  rooms?: Plan.Rooms;
  sessions?: Plan.Sessions;
  steward: { avatar?: string; id: string; name: string };
  timeZone: string;
};

export const parsePlan = (yaml: string): Plan => {
  const plan = assertEquals<Plan>(load(yaml));

  const { users } = plan.powerLevels;
  if (!(users?.["steward"] === 100)) throw new Error("Insufficient steward power level");
  delete Object.assign(users, { [plan.steward.id]: users["steward"] })["steward"];

  return plan;
};
