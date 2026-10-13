export interface LocalStartupActions {
  command: (step: 'start-sql' | 'init' | 'data', container: string) => Promise<void>;
  serve: (container: string) => Promise<void>;
}

export async function startLocalApplication(
  container: string, actions: LocalStartupActions, report: (message: string) => void = console.log,
): Promise<void> {
  const stages = [
    {
      name: 'SQL container', run: () => actions.command('start-sql', container),
      recovery: 'Keep existing data. Read the specific cause before deciding whether this is Docker, image access, or preview control-plane recovery. Retry start-sql with the same approved container; any recover-sql recreation requires separate approval.',
    },
    {
      name: 'Schema and SQL tools', run: () => actions.command('init', container),
      recovery: 'Keep SQL data/credential state. Check the SDK, download/proxy errors and schema error; retry init only after fixing the cause.',
    },
    {
      name: 'Data API', run: () => actions.command('data', container),
      recovery: 'Check the workspace data container and selected DAB port reported by workspace-check. Retry data for this SQL container after resolving the conflict; never stop unrelated services.',
    },
    {
      name: 'Browser gateway', run: () => actions.serve(container),
      recovery: 'Check who owns the workspace gateway port and reuse the intended app. If free, retry serve for this SQL container; choose your development user after restart.',
    },
  ];
  for (const [index, stage] of stages.entries()) {
    report(`[${index + 1}/${stages.length}] Starting ${stage.name}. First-time downloads/builds may still be in progress.`);
    try { await stage.run(); }
    catch (error) {
      throw new Error(`Local startup stopped at ${stage.name}. ${stage.recovery} See docs/guides/getting-started.md.`, { cause: error });
    }
    if (index < stages.length - 1) report(`[${index + 1}/${stages.length}] ${stage.name} completed.`);
  }
}
