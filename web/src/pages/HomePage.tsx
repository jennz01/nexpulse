import { HomeGrid } from '../layout/HomeGrid';
import { ActionStrip } from '../panels/ActionStrip';
import type { PageContext } from './context';

export function HomePage(ctx: PageContext) {
  return (
    <div className={ctx.customizing ? 'cz' : undefined}>
      <ActionStrip chips={ctx.chips} onNavigate={ctx.navigate} />
      <HomeGrid ctx={ctx} />
    </div>
  );
}
