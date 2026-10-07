async function handleHourInput(
  ctx: Context,
  env: Env,
  session: TrackSessionRow,
  input: string
): Promise<void> {
  const hour = parseInt(input, 10);
  if (isNaN(hour) || hour < 0 || hour > 23) {
    await ctx.reply(
      '❌ Jam tidak valid. Kirim angka <code>0</code>–<code>23</code>.\n\n' +
        'Contoh: <code>18</code>',
      { parse_mode: 'HTML' }
    );
    return;
  }

  await updateTrackSession(env.DB, session.session_id, {
    schedule_hour: hour,
    step: 'confirm',
  });

  const updated: TrackSessionRow = {
    ...session,
    schedule_hour: hour,
    step: 'confirm',
  };

  let existsInRepo = false;
  if (updated.slug) {
    try {
      const f = await githubGetFile(
        env,
        `src/content/anime/${updated.slug}.md`,
        'qimochi'
      );
      existsInRepo = !!f;
    } catch {}
  }

  await ctx.reply(buildSummary(updated, existsInRepo), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: buildConfirmKeyboard(session.session_id),
  });
}
