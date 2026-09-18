import { ActionStrip } from '../panels/ActionStrip';
import { StoresCard } from '../panels/cards';
import type { PageContext } from './context';

export function StoresPage(ctx: PageContext) {
  return (
    <>
      <ActionStrip chips={ctx.chips.filter((c) => c.target === 'stores')} onNavigate={ctx.navigate} />
      <main className="single">
        <StoresCard ctx={ctx} />
      </main>
    </>
  );
}
