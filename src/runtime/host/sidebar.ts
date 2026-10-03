import { createRequire } from 'node:module';
import { componentText } from '../../minecraft/vanillaCompat.js';
import type { ScoreboardLine } from '../../core/rules.js';

const require = createRequire(import.meta.url);

export interface SidebarState {
  title: string;
  lines: ScoreboardLine[];
}

/** Plain text of a component as the protocol hands it over (NBT 1.20.3+, JSON string before, or a ChatMessage). */
function textOf(value: unknown): string {
  if (value == null) return '';
  try {
    if (typeof value === 'string') {
      try {
        return componentText(JSON.parse(value));
      } catch {
        return value;
      }
    }
    const v = value as any;
    if (v.type && v.value !== undefined && !('text' in v) && !('extra' in v)) {
      const json = require('prismarine-chat').processNbtMessage(v);
      return json ? componentText(JSON.parse(json)) : '';
    }
    return componentText(v);
  } catch {
    return '';
  }
}

/**
 * Keeps track of the sidebar scoreboard as the player sees it – including what mineflayer leaves out:
 * since 1.20.3 a score can carry its own display text and a number format (blank = no number shown),
 * which is how modern scoreboard plugins draw their lines. Teams (prefix + name + suffix) come from
 * mineflayer. `onChange` gets the visible lines (top to bottom) whenever they changed.
 */
export function watchSidebar(bot: any, onChange: (s: SidebarState) => void, debounceMs = 1000): () => void {
  const client = bot._client;
  const objectives = new Map<string, { title: string; blank: boolean; fixed: string | null }>();
  const scores = new Map<string, Map<string, { value: number; display: string | null; blank: boolean | null; fixed: string | null }>>();
  let sidebar: string | null = null;
  let last = '';
  let timer: NodeJS.Timeout | null = null;

  const format = (nf: unknown, styling: unknown): { blank: boolean; fixed: string | null } | null => {
    if (nf === undefined || nf === null) return null;
    if (nf === 0) return { blank: true, fixed: null };
    if (nf === 2) return { blank: true, fixed: textOf(styling) };
    return { blank: false, fixed: null };
  };

  const compute = (): SidebarState | null => {
    if (!sidebar) return null;
    const obj = objectives.get(sidebar);
    const entries = scores.get(sidebar);
    if (!obj || !entries) return { title: obj?.title ?? '', lines: [] };
    const lines = [...entries.entries()]
      .sort((a, b) => b[1].value - a[1].value || a[0].localeCompare(b[0]))
      .slice(0, 15)
      .map(([name, e]) => {
        let text = e.display;
        if (text === null) {
          const team = bot.teamMap?.[name];
          text = team ? textOf(team.displayName(name)) : name;
        }
        text = text.replace(/§[0-9a-fk-orx]/gi, '').slice(0, 200);
        const blank = e.blank ?? obj.blank;
        const fixed = e.fixed ?? (e.blank === null ? obj.fixed : null);
        return fixed ? { text: `${text} ${fixed}`.trim(), value: e.value, hidden: true } : { text, value: e.value, ...(blank ? { hidden: true } : {}) };
      });
    return { title: obj.title.slice(0, 120), lines };
  };

  const changed = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const s = compute();
      const key = JSON.stringify(s);
      if (!s || key === last) return;
      last = key;
      onChange(s);
    }, debounceMs);
    timer.unref?.();
  };

  const onObjective = (p: any) => {
    if (p.action === 1) {
      objectives.delete(p.name);
      scores.delete(p.name);
      if (sidebar === p.name) sidebar = null;
    } else {
      const f = format(p.number_format, p.styling);
      objectives.set(p.name, { title: textOf(p.displayText), blank: f?.blank ?? false, fixed: f?.fixed ?? null });
    }
    changed();
  };
  const onDisplay = (p: any) => {
    if (Number(p.position) !== 1) return; // 1 = sidebar (team-coloured sidebars are not shown to this player)
    sidebar = p.name || null;
    changed();
  };
  const remove = (entity: string, objective: string | null | undefined) => {
    if (objective) scores.get(objective)?.delete(entity);
    else for (const m of scores.values()) m.delete(entity);
  };
  const onScore = (p: any) => {
    if (p.action === 1) remove(p.itemName, p.scoreName);
    else {
      let m = scores.get(p.scoreName);
      if (!m) scores.set(p.scoreName, (m = new Map()));
      const f = format(p.number_format, p.styling);
      m.set(p.itemName, { value: Number(p.value) || 0, display: p.display_name !== undefined && p.display_name !== null ? textOf(p.display_name) : null, blank: f ? f.blank : null, fixed: f?.fixed ?? null });
    }
    changed();
  };
  const onReset = (p: any) => {
    remove(p.entity_name, p.objective_name);
    changed();
  };

  client.on('scoreboard_objective', onObjective);
  client.on('scoreboard_display_objective', onDisplay);
  client.on('scoreboard_score', onScore);
  client.on('reset_score', onReset);
  // team prefixes / suffixes change the text of a line
  client.on('teams', changed);
  return () => {
    if (timer) clearTimeout(timer);
    client.removeListener('scoreboard_objective', onObjective);
    client.removeListener('scoreboard_display_objective', onDisplay);
    client.removeListener('scoreboard_score', onScore);
    client.removeListener('reset_score', onReset);
    client.removeListener('teams', changed);
  };
}
