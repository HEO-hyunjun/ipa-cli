// @ts-check
// Bench vault policy: warn (without blocking) when this session previewed an ipa
// mutation (move/rename/cascade/link dry-run) but never ran its --apply/apply.
// ctx.session.pending_mutations is command-name granularity only — it names the
// previewed command(s), not the target note. block:false keeps this advisory: the
// Stop gate surfaces the message to the agent without holding the response. Flip
// block to true to hard-block a session that ends on an unapplied plan.
/** @type {import("../types/ipa-plugin").Gate} */
const gate = {
  name: "unapplied-mutation-gate",
  check(ctx) {
    const pending = ctx.session.pending_mutations ?? [];
    if (!pending.length) return null;
    const commands = [...new Set(pending.map((item) => item.command))].join(", ");
    return {
      block: false,
      message: `${pending.length} mutation plan(s) produced this session were never applied (e.g. move/rename/cascade dry-run without --apply): ${commands}. Run the corresponding --apply, or confirm the plan was intentionally left unapplied.`
    };
  }
};
export default gate;
