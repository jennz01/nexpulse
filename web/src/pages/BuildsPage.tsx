import { ActionStrip } from '../panels/ActionStrip';
import { BuildsCard } from '../panels/cards';
import type { PageContext } from './context';

export function BuildsPage(ctx: PageContext) {
  return (
    <>
      <ActionStrip chips={ctx.chips.filter((c) => c.target === 'builds')} onNavigate={ctx.navigate} />
      <main className="single">
        <BuildsCard ctx={ctx} full />
      </main>
    </>
  );
}
