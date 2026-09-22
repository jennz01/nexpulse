import { ActionStrip } from '../panels/ActionStrip';
import { ReleasesCard } from '../panels/cards';
import type { PageContext } from './context';

export function ReleasesPage(ctx: PageContext) {
  return (
    <>
      <ActionStrip chips={ctx.chips.filter((c) => c.target === 'releases' || c.target === 'builds')} onNavigate={ctx.navigate} />
      <main className="single">
        <ReleasesCard ctx={ctx} />
      </main>
    </>
  );
}
