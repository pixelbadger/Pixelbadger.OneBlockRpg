import { z } from "zod";
import { Payload } from "./schema.js";

/** The published JSON Schema for a merged payload (§7.3), generated from the zod types. */
export function payloadJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(Payload, { io: "input", cycles: "ref", unrepresentable: "any" }) as Record<
    string,
    unknown
  >;
  return {
    ...schema,
    $id: "https://github.com/pixelbadger/Pixelbadger.OneBlockRpg/schema/payload.schema.json",
    title: "One Block CRPG game payload",
    description:
      "A merged game payload. On disk it is split across game.yaml, story.yaml, rooms/, objects/, characters/, " +
      "conversations/, hooks.yaml, behaviours/, callouts.yaml, set_pieces/ and combat_text.yaml (spec §7.3).",
  };
}
