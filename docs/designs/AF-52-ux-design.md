# AF-52 — UX Design: Agent Factory Web UI

**Ticket:** AF-52
**Designer:** ux-designer
**Date:** 2026-06-02
**Stack:** Next.js 16, React 19, Tailwind CSS v4, Shadcn/ui, Lucide icons, Geist font

---

## 0. Before We Design Anything

### Who uses this daily?

**Primary user: Brahma (the owner).** One power user. Uses this 8+ hours a day. Spawns agents, tracks tasks, reviews results, edits agent prompts. Deep familiarity with the system — does not need hand-holding, needs speed. The UI should respect that.

**Secondary: Agents themselves.** Agents read task files and project context. The web UI is a human layer on top of the file system — it doesn't need to explain the system to newcomers; it needs to get out of the way of someone who already knows it.

### What are they trying to accomplish?

1. **Dispatch work**: Pick an agent, give it a task or start a chat
2. **Track tasks**: See what's in-progress, backlog, blocked
3. **Edit agents**: Adjust prompts, configure execution backend
4. **Review orchestration**: See which domains are running, trigger new runs
5. **Browse files**: Look at output artifacts and task files

### Current tech stack constraints

- Shadcn/ui components — available and should be extended, not replaced
- Tailwind CSS v4 — using OKLCH color values (modern, good)
- Lucide icons — already wired throughout
- `react-markdown` + `remark-gfm` — rendering agent content
- Next.js App Router — layout-level composition
- No animation library currently beyond `tw-animate-css`

---

## 1. Audit: Current State Issues

### Issue 1 — Agents page: Card grid fails at scale

**Problem**: 20+ agents presented as cards in a 1–4 column grid. Each card repeats the same structural chrome (border, padding, two icon buttons). At 30+ agents this becomes a wall of boxes. The card format is justified when you have rich preview content — here, every card shows: name, role, version badge, model badge, modified date, two icon buttons. That's a list row, not a card.

**Impact**: High. Power user scans agents frequently. Extra scrolling and visual noise add up every session.

**Fix**: Replace with a compact list (see §4.1).

### Issue 2 — No Tasks view

**Problem**: The entire purpose of Agent Factory is task management. The task files exist (`/.af/tasks/`), the API likely has project/task data, but there is no task browser in the web UI. A user who wants to know "what is in-progress?" must use the CLI or read files directly.

**Impact**: Critical feature gap. The web UI feels incomplete without it.

**Fix**: Add a Tasks section (see §4.2).

### Issue 3 — Chat empty state is a two-step funnel with a ceiling

**Problem**: The empty state shows a 2-column grid of "Core" agents only, then a "More agents" button that opens a dialog with all agents in a scrollable list. Two clicks and a modal to start a conversation. Also: showing only `type === 'bridge'` agents initially means SDK agents are buried.

**Impact**: Medium. It works, but it's not the fastest path to the most common action.

**Fix**: Single-step agent search on the empty state (see §4.3).

### Issue 4 — Domains page: read-only dead end

**Problem**: You can see domains and their roster agents, but you cannot do anything. There's no "Run orchestration" action. The page is informational but the actual orchestration (`af orchestrate`) happens only from the CLI.

**Impact**: Medium. A power user who already knows the CLI will not miss this. But as AF matures toward a web-native workflow, this needs an action.

**Fix**: Add an orchestration trigger panel (see §4.4).

### Issue 5 — Projects page: hollow shell

**Problem**: The Projects page shows a card for each project with a name, prefix, and task count. Clicking a card does nothing — there's no routing to a project detail page. The task count is informational but not actionable.

**Impact**: Medium. No drill-through = dead-end navigation.

**Fix**: Redesign as a list with expandable task breakdown (see §4.5).

### Issue 6 — Color system: technically correct, expressively flat

**Problem**: The current palette is pure grayscale (OKLCH with chroma = 0 throughout). This avoids the AI-blue cliché, which is the right call. But it also means every surface, every border, every button background is a grey-to-grey transition. There's no visual heat or warmth — nothing that says "this tool has personality." The chart colors (OKLCH blues) appear only in charts that don't exist yet.

**Impact**: Low (functional) but worth addressing for brand identity.

**Fix**: Introduce a single warm accent token — amber/gold — for primary interactive elements. Keep all other surfaces grayscale. This is "surprise with restraint" (§Design Principles #3). See §2.

---

## 2. Design Tokens

### 2.1 Color Palette

All values in OKLCH. The base system (from globals.css) stays — we layer in one new semantic token.

#### Light Mode

```css
/* Base (unchanged from globals.css) */
--background:           oklch(1 0 0);        /* #ffffff — true white */
--foreground:           oklch(0.145 0 0);     /* ~#1a1a1a — near-black */
--muted:                oklch(0.97 0 0);      /* #f7f7f7 — off-white */
--muted-foreground:     oklch(0.556 0 0);     /* ~#737373 — gray-500 */
--border:               oklch(0.922 0 0);     /* ~#e8e8e8 — gray-200 */

/* Primary — CHANGE: warm instead of pure black */
--primary:              oklch(0.38 0.10 70);  /* warm amber-dark: #6b4a00 approx */
--primary-foreground:   oklch(0.985 0 0);     /* near-white */

/* New semantic token for active/highlight states */
--accent-warm:          oklch(0.76 0.13 75);  /* amber/gold: #d4900a approx */
--accent-warm-subtle:   oklch(0.95 0.04 75);  /* light amber wash */

/* Semantic status colors */
--status-active:        oklch(0.55 0.18 142); /* green — in-progress */
--status-blocked:       oklch(0.58 0.22 27);  /* red — blocked (same as --destructive) */
--status-backlog:       oklch(0.556 0 0);     /* gray — backlog */
--status-done:          oklch(0.55 0.13 142); /* muted green — done/released */
--status-review:        oklch(0.60 0.15 55);  /* orange — ready-for-qa */

/* Priority dot colors */
--priority-critical:    oklch(0.58 0.22 27);  /* red */
--priority-high:        oklch(0.62 0.18 47);  /* orange */
--priority-medium:      oklch(0.66 0.14 75);  /* amber */
--priority-low:         oklch(0.60 0.05 0);   /* neutral gray */
```

**Rationale for amber primary**: Amber/gold reads as "intelligent" and "deliberate" without the AI-startup blue. It's warm without being aggressive. One color change, maximum impact. Pure blacks as primary had no character.

#### Dark Mode (additions only)

```css
/* Primary in dark: slightly lighter amber so it's legible */
--primary:              oklch(0.76 0.13 75);  /* amber that glows */
--primary-foreground:   oklch(0.145 0 0);     /* dark text on amber */

/* Active accent */
--accent-warm:          oklch(0.76 0.13 75);
--accent-warm-subtle:   oklch(0.25 0.06 75);  /* dark amber wash */
```

**Hex approximations for engineers** (OKLCH → sRGB, use OKLCH in the actual code):

| Token | Light | Dark |
|---|---|---|
| `--primary` | `#5c3b00` | `#d4900a` |
| `--accent-warm` | `#d4900a` | `#d4900a` |
| `--status-active` | `#1a7a3e` | `#3db870` |
| `--status-blocked` | `#dc2626` | `#f87171` |
| `--priority-critical` | `#dc2626` | `#f87171` |
| `--priority-high` | `#ea580c` | `#fb923c` |
| `--priority-medium` | `#d97706` | `#fbbf24` |

### 2.2 Typography Scale

Font: **Geist Sans** (body/UI) + **Geist Mono** (code/IDs/frontmatter). Already in the stack.

```
xs:   11px / 0.6875rem — meta, badges, timestamps, modified dates
sm:   12px / 0.75rem   — secondary labels, captions, helper text
base: 14px / 0.875rem  — default body text, list items, descriptions
md:   15px / 0.9375rem — section headers, emphasized content
lg:   16px / 1rem       — page-level headings
xl:   20px / 1.25rem   — major section titles
2xl:  24px / 1.5rem    — page h1 (use sparingly)
```

**Line heights:**
- UI elements (buttons, labels, table cells): `leading-none` (1.0) or `leading-tight` (1.25)
- Body prose: `leading-relaxed` (1.625)
- Multi-line descriptions: `leading-snug` (1.375)

**Font weights:**
- `400` — body, labels
- `500` — names, key values, table column values
- `600` — section headings, card titles, nav items (active)

### 2.3 Spacing Scale

All spacing follows a **4px base grid**.

```
1  = 4px
2  = 8px
3  = 12px
4  = 16px
5  = 20px
6  = 24px
8  = 32px
10 = 40px
12 = 48px
16 = 64px
```

**Component-level conventions:**

| Context | Value |
|---|---|
| Row height (compact list) | 40px (10 × 4px) |
| Row height (comfortable list) | 48px (12 × 4px) |
| Page padding (desktop) | 24px (6 × 4px) |
| Section gap | 32px (8 × 4px) |
| Inline element gap | 6px (1.5 × 4px) — Tailwind `gap-1.5` |
| Panel header height | 48px or 40px |
| Sidebar item height | 36px |

### 2.4 Radius & Shadows

```css
--radius:     0.625rem;  /* 10px — base, from existing */
--radius-sm:  6px;
--radius-md:  8px;
--radius-lg:  10px;
--radius-xl:  14px;
```

**Shadow tokens** (not currently in the system — add these):

```css
--shadow-xs:   0 1px 2px 0 oklch(0 0 0 / 0.05);
--shadow-sm:   0 1px 3px 0 oklch(0 0 0 / 0.10), 0 1px 2px -1px oklch(0 0 0 / 0.10);
--shadow-md:   0 4px 6px -1px oklch(0 0 0 / 0.10), 0 2px 4px -2px oklch(0 0 0 / 0.10);
--shadow-focus: 0 0 0 3px oklch(0.76 0.13 75 / 0.30);  /* amber focus ring */
```

**Dark mode adjustments:** increase opacity by ~50% for shadows (dark surfaces absorb less light).

### 2.5 Motion

```css
--duration-fast:   100ms;   /* micro-interactions: checkbox, toggle, badge */
--duration-base:   150ms;   /* default: hover states, button presses */
--duration-slow:   250ms;   /* panel slides, modal open, tab switches */
--ease-standard:   cubic-bezier(0.4, 0, 0.2, 1);   /* material standard */
--ease-enter:      cubic-bezier(0, 0, 0.2, 1);      /* decelerate — things entering */
--ease-exit:       cubic-bezier(0.4, 0, 1, 1);      /* accelerate — things leaving */
```

**Rules:**
- Hover state changes: 150ms ease-standard
- Panel slide in/out: 250ms ease-enter / 200ms ease-exit
- Skeleton → content: 200ms fade, no slide
- No animation for purely decorative state changes
- Respect `prefers-reduced-motion`: set all durations to 0 and remove transforms

---

## 3. Information Architecture

### 3.1 Current Navigation

```
/chat      — Chat with agents
/projects  — Project list
/agents    — Agent registry
/domains   — Orchestration domains
/files     — File browser (stub)
```

### 3.2 Proposed Navigation

Add **Tasks** — the missing core feature.

```
/chat      — Chat with agents (no change in position)
/tasks     — Task browser (NEW — move to position 2, after chat)
/projects  — Project list (move to position 3)
/agents    — Agent registry (position 4)
/domains   — Orchestration (position 5, rename from "Domains")
/files     — Files (position 6, keep stub for now)
```

**Justification for ordering**: Frequency of use. Chat is the primary action. Tasks is the most important information view. Projects contextualizes tasks. Agents are edited infrequently. Orchestration/Domains is power-user territory.

**Sidebar items** (updated):

```tsx
const navItems = [
  { title: 'Chat',         href: '/chat',         icon: MessageSquare },
  { title: 'Tasks',        href: '/tasks',         icon: ListChecks },   // NEW
  { title: 'Projects',     href: '/projects',      icon: FolderOpen },
  { title: 'Agents',       href: '/agents',        icon: Bot },
  { title: 'Orchestrate',  href: '/domains',       icon: Workflow },     // rename
  { title: 'Files',        href: '/files',         icon: FileText },
];
```

### 3.3 Page Relationships

```
/tasks
  └── [AF-52] task detail (slide-over or /tasks/AF-52)
      └── run agent on task (links to /chat?agent=X)

/agents
  └── [slug] agent profile (right panel)
      └── edit agent body (inline editor)
      └── configure execution (execution panel)
      └── chat with agent (links to /chat?agent=slug)

/domains
  └── [domain] domain detail
      └── trigger orchestration (slide-over form)
      └── run history (future)

/chat
  └── [slug] active chat (tab)
      └── links to /agents/[slug] for editing
```

---

## 4. Component Specifications

### 4.1 Agents Page — List Layout

**Design decision: List, not cards.**

Cards are justified when items have rich preview content (images, sparklines, variable-length descriptions). An agent card has: name (short), role (1 line), model (short), version (number), modified date, two icon buttons. That is a list row. The card grid adds ~40px of padding per item that communicates nothing.

The list also supports better power-user behavior: rows can be keyboard-navigated, sortable by clicking column headers, and scanned top-to-bottom far faster than reading a 2D grid.

**Layout**:

```
┌─────────────────────────────────────────────────────────┬──────────────────────┐
│ AGENTS                                                  │                      │
│ 23 agents                                    [+ New]   │  Agent Profile Panel  │
├──────────────────────────────────────────────────────────│                      │
│ Search agents...              [Core ▾] [All ▾]          │  (visible when       │
├────────────────────────────────────────────────────────  │   row selected)      │
│ NAME ↑               ROLE                  MODEL    TYPE │                      │
├──────────────────────────────────────────────────────────│                      │
│ ● Agni               Orchestration Lead     sonnet   SDK │                      │
│ ● Architect          System Architect       sonnet   SDK │                      │
│   Content Writer     …                      sonnet   SDK │                      │
│ …                                                        │                      │
└─────────────────────────────────────────────────────────┴──────────────────────┘
```

**Row anatomy** (48px height):

```
[●] [Name — 500 weight, 14px]  [Role — 400 weight, 14px, muted]  [Model tag]  [Type badge]  [≡ actions]
 4px  12px  ← flexible →                                           fixed 120px   fixed 80px    32px
```

- Dot (`●`): colored by agent type — amber for SDK agents, muted gray for bridge agents
- Name: `font-medium text-sm text-foreground`
- Role: `text-sm text-muted-foreground`, truncated with ellipsis at 40% column width
- Model tag: `font-mono text-xs bg-muted rounded-md px-1.5 py-0.5` — model string with `claude-` prefix stripped
- Type badge: `text-xs` — "Core" (bridge) or "SDK" — no filled background, just border
- Actions (on hover): Eye icon (view profile) + MessageSquare icon (open chat) — 28px icon buttons

**Sort columns**: NAME (default, ascending), ROLE, MODEL, TYPE. Click column header to sort. Active sort column has `↑` or `↓` arrow.

**Filter strip**: Above the list, two filter chips:
- "Type" dropdown: All / Core / Specialized
- Search: text input, filters by name and role in real-time, debounced 150ms

**All states:**

| State | Behavior |
|---|---|
| Default | Row with subtle bottom border (`border-border/50`) |
| Hover | `bg-muted/50` background, show action buttons |
| Selected | `bg-accent-warm-subtle border-l-2 border-l-primary` — left accent stripe, full-width |
| Focus (keyboard) | `ring-2 ring-primary` — visible outline, matches action |
| Loading | 8 skeleton rows, name/role/model shimmer with `animate-pulse` |
| Empty (no agents) | Centered message: "No agents registered. Run `af agent sync` to import agents." — monospace code style for the command |
| Empty (search) | "No agents match '…'" with clear-search link |
| 0 agents | Same as empty |
| 50+ agents | Virtual scrolling (use `react-virtual` or Tanstack Virtual) — row count shown in header |

**Profile panel** (right, 384px / `w-96`):
- Stays as-is from the current implementation — it's well done
- Add: "Open in Chat" primary button at the top of the panel
- Add: keyboard shortcut hint `[↵]` next to "Open in Chat" for power user

**Responsive**:
- `≥1280px` (xl): list + profile panel side by side
- `768–1279px` (md): list only; profile slides in as a drawer from the right (Shadcn `Sheet`)
- `<768px` (sm): list only; selecting a row navigates to `/agents/[slug]` — full-page profile

---

### 4.2 Tasks View (New Page)

**This is the most important missing feature.**

#### Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│  TASKS                                           [AF] ▾  [+ Create task]   │
│  agent-factory · 47 tasks                                                  │
├────────────────────────────────────────────────────────────────────────────┤
│  [backlog 12] [open 1] [in-progress 1] [ready-for-qa 1] [uat 9] [done 23]  │
├────────────────────────────────────────────────────────────────────────────┤
│  Search tasks...                        [Priority ▾] [Assignee ▾] [≡ Cols] │
├────────────────────────────────────────────────────────────────────────────┤
│  TICKET      TITLE ↑                    ASSIGNEE     PRIORITY   UPDATED    │
├────────────────────────────────────────────────────────────────────────────┤
│  AF-51  ●   Harden SDK spawn: strip…    engineer     medium     2 hrs ago  │
│  AF-50      Pipeline status cmd         —            high       1 day ago  │
│  …                                                                          │
└────────────────────────────────────────────────────────────────────────────┘
```

#### Status pipeline header

A horizontal strip of clickable status pills. Each pill shows status name + count. Active filter pill is highlighted with `bg-accent-warm-subtle text-foreground border-accent-warm`. Default: shows ALL tasks (no filter). Clicking a pill filters to that status.

```
[ backlog 12 ]  [ open 1 ]  [ in-progress 1 ]  [ ready-for-qa 1 ]  [ uat 9 ]  [ done 23 ]
```

Spacing: `gap-2`, pills are `rounded-full px-3 py-1 text-xs font-medium`. Each pill has a subtle colored left dot:
- `backlog` → gray dot
- `open` → blue-gray dot
- `in-progress` → amber dot (warm!)
- `ready-for-qa` → orange dot
- `uat` → purple dot
- `done`/`released` → green dot

#### Row anatomy (44px height)

```
[TICKET]   [●]  [TITLE]             [ASSIGNEE]   [PRIORITY]  [UPDATED]
AF-52       ●   UX Design: Ag...    ux-designer  ↑ high      2 hrs ago
```

- **TICKET**: `font-mono text-xs text-muted-foreground` — `w-16` fixed
- **Status dot** (`●`): 8px circle, colored by status (see above), `w-6`
- **TITLE**: `text-sm font-medium text-foreground`, truncated at `max-w` dynamically, flex-1
- **ASSIGNEE**: `text-xs text-muted-foreground` — slug string, `w-28`
- **PRIORITY**: colored badge. No filled backgrounds — just a colored `●` dot + text. `w-20`
  - `critical` — red dot + "critical"
  - `high` — orange dot + "high"
  - `medium` — amber dot + "medium"
  - `low` — gray dot + "low"
- **UPDATED**: `text-xs text-muted-foreground` — relative time ("2 hrs ago", "3 days ago"), `w-24`

**Priority** uses dots not filled badges because filled badges add visual noise at list scale. The dot + label is readable at `xs` and doesn't compete with the title.

#### Task detail (slide-over)

Clicking any row opens a right-side slide-over (`Sheet` component, `w-[560px]`), **not** a navigation change. This keeps the list visible and makes "scan list → read detail → go back" instant.

Slide-over content:
```
┌─────────────────────────────────┐
│  AF-52                     [×]  │
│  UX Design: Agent Factory…      │
│                                 │
│  Status:    in-progress    [▾]  │
│  Assignee:  ux-designer         │
│  Priority:  high                │
│  Created:   2026-06-02          │
│  Updated:   2026-06-02          │
│                                 │
│  ─── Objective ─────────────    │
│  <markdown body>                │
│                                 │
│  ─── Log ───────────────────    │
│  [2026-06-02] ux-designer: …    │
│  [2026-06-02] ux-designer: …    │
│                                 │
│  [Assign to agent ▾] [Move ▾]   │
└─────────────────────────────────┘
```

The "Status" field is a dropdown. Changing it calls `af task move` via a POST API endpoint. Same for "Assign to agent" — a dropdown of agent slugs.

The Log section renders with monospace font, timestamp highlighted in amber, agent slug in medium weight:
```
· [2026-06-02T10:00Z] ux-designer: spawn.start | Starting UX design…
```

#### All states

| State | Behavior |
|---|---|
| Loading | 3 skeleton status pills, then 10 skeleton rows |
| Empty (no tasks) | "No tasks yet. Create one with `af task create`" |
| Empty (filtered) | "No tasks match this filter" + [Clear filters] link |
| Row hover | `bg-muted/50`, show actions (move, assign) as ghost buttons |
| Row selected | `bg-accent-warm-subtle`, slide-over opens |
| Slide-over loading | Spinner centered in panel |
| Slide-over error | "Task not found" with close button |
| 100+ tasks | Pagination (25 per page) or virtual scroll |

---

### 4.3 Chat Page Improvements

#### Current problem

The empty state:
1. Shows only `type === 'bridge'` agents in a 2-col grid (hardcoded subset)
2. "More agents" opens a modal with a scrollable list of ALL agents
3. Two clicks, a modal interrupt, for the most common action

#### Redesign: Agent command search

Replace the grid + "More agents" pattern with a single, immediate search. The whole empty state IS the search — no extra steps.

```
┌─────────────────────────────────────────┐
│                                         │
│         Talk to an agent               │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │  🔍  Search agents...           │    │
│  └─────────────────────────────────┘    │
│                                         │
│  Agni         Orchestration Lead        │
│  Architect    System Architect          │
│  Engineer     Backend engineer          │
│  Researcher   Research analyst          │
│  ── ── ── ── ── ── ── ── ── ── ──      │
│  + 19 more   ←  not shown until typed  │
│                                         │
└─────────────────────────────────────────┘
```

Behavior:
- On page load, show top 4–5 agents by type (bridge first, then sdk, sorted by name)
- The search input is focused immediately (autofocus)
- Typing filters all agents by name + role in real-time
- Results show as a list (not a grid) with keyboard navigation (↑/↓ to select, Enter to open)
- No dialog — the search results are inline below the input

**Search input spec:**
- `h-11 w-full max-w-sm rounded-lg border border-input bg-background px-4 text-sm`
- Placeholder: `Search agents…`
- Keyboard: `↑/↓` to navigate results, `Enter` to open, `Escape` to clear
- Icon: `Search` (lucide) on the left, `⌘K` hint text on the right (for keyboard discovery)

**Agent result row:**
```
[Name  font-medium]  [role  text-muted-foreground text-xs]          [→]
```
- 44px height
- Hover: `bg-muted/70`
- Keyboard-focused: `bg-muted ring-1 ring-primary`

**When chats are open (tab bar):**
No change needed to the current tab bar design — it works well. Minor improvement: add `title` tooltip to truncated agent names in tabs. The `+` button to add a tab should open the same search inline, not a modal dialog.

#### Chat area itself

The `ChatPanel` component is solid. Minor improvements:

1. **Agent header** — The green dot (`bg-emerald-600`) is hardcoded. Use `--status-active` token instead. For agents of different types/statuses, allow future extensibility.

2. **Typing indicator** — Good. Keep the spinner and `"{name} is thinking…"` pattern.

3. **Timestamp visibility** — Messages currently have no timestamp visible. Add hover-reveal timestamps (`opacity-0 group-hover:opacity-100 transition-opacity`) for the power user who needs to know when something was said.

4. **Message bubble** — Not audited directly (need to see `message-bubble.tsx`). Assumption: user messages right-aligned, agent messages left-aligned with agent avatar. Verify consistent `max-w` and word-break handling for long code blocks.

5. **Input row** — The Send button icon-only approach is correct. Add `Cmd+Enter` as an alternative to `Enter` for sending (some users prefer `Enter` to insert newlines). Document this with a subtle hint in the placeholder text or a `?` tooltip.

---

### 4.4 Domains Page — Orchestration Trigger

#### Current state

Read-only list of domains showing supervisor + roster. No action possible.

#### Redesign

Keep the read-only domain cards but add a "Run Orchestration" button per domain. Clicking opens a slide-over panel.

```
┌──────────────────────────────────────────────────────┐
│  ORCHESTRATION  (read-only — edit domains in CLI)    │
├──────────────────────────────────────────────────────┤
│  ┌────────────────────────────────────────────────┐  │
│  │  marketing                   [Run ▶]           │  │
│  │                                                │  │
│  │  Supervisor: orchestration-supervisor          │  │
│  │  Goal: Plan and execute marketing campaigns    │  │
│  │                                                │  │
│  │  Roster (3)                                    │  │
│  │  · content-writer  · researcher  · planner     │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

**Run slide-over** (opens from [Run ▶] button):

```
┌──────────────────────────────────┐
│  Run: marketing           [×]   │
├──────────────────────────────────┤
│                                  │
│  Objective *                     │
│  ┌────────────────────────────┐  │
│  │ Write a product launch     │  │
│  │ campaign for Q3...         │  │
│  │                            │  │
│  └────────────────────────────┘  │
│                                  │
│  Max delegations          [5]    │
│  (steps the supervisor can take) │
│                                  │
│  [Cancel]   [▶ Run Orchestration]│
│                                  │
│  ─── Recent runs ────────────    │
│  No runs yet                     │
└──────────────────────────────────┘
```

Fields:
- **Objective** (required): `Textarea`, min 3 rows, max 600 chars. Placeholder: "Describe what the orchestration should accomplish…"
- **Max delegations**: number input, default 10, range 1–50
- **Run button**: disabled when objective is empty. On click: POST `/api/orchestrate` with `{ domain, objective, maxDelegations }`. Button text changes to "Running…" with spinner.

**Success state**: After run completes, show a result summary in the slide-over:
```
┌─────────────────────────────────┐
│  Run complete                   │
│                                 │
│  Steps: 4                       │
│  Backend: claude                │
│  Total tokens: 12,400           │
│  Stop reason: completed         │
│                                 │
│  [View full output ↗]  [Close]  │
└─────────────────────────────────┘
```

**Error state**: Show the error message from the API in a red `alert` component within the slide-over. Keep the form visible so the user can modify and retry.

---

### 4.5 Projects Page Redesign

#### Current state

Cards showing project name, prefix, task count. No interactions.

#### Redesign: List with inline task breakdown

```
┌────────────────────────────────────────────────────┐
│  PROJECTS                                          │
├────────────────────────────────────────────────────┤
│  agent-factory      AF  ·  47 tasks                │
│    ─ in-progress: 1  ·  ready-for-qa: 1  ·  uat: 9│
│    [View tasks ↗]  [Chat with agent ↗]             │
├────────────────────────────────────────────────────┤
│  oracle-bridge      ORA  ·  22 tasks               │
│    ─ in-progress: 2  ·  blocked: 1                 │
│    [View tasks ↗]  [Chat with agent ↗]             │
└────────────────────────────────────────────────────┘
```

Each project is a list row that expands on click to show:
1. Task count by status (only non-zero statuses shown)
2. "View tasks" → navigates to `/tasks?project=AF`
3. "Chat with agent" → opens the chat with the project's default agent

**Collapsed row** (56px):
- `font-semibold text-sm text-foreground` for project name
- `font-mono text-xs bg-secondary px-1.5 py-0.5 rounded` for prefix badge
- `text-xs text-muted-foreground` for task count
- Chevron right (`›`) for expand affordance

**Expanded row**: slides open with `height` animation (250ms ease-enter). Shows task breakdown as colored text: `in-progress` (amber), `blocked` (red), `uat` (muted-purple), etc.

---

### 4.6 Files Page (Stub → Minimal Viable)

The Files page currently shows "coming soon." Rather than designing the full file browser now (complex), design a minimal useful state:

**Phase 1 (immediate)**: Show the task output files that exist in `.af/output/`. This is directly useful — agents write their results here.

```
┌────────────────────────────────────────────────────┐
│  FILES                                             │
│  Browse task outputs and workspace files           │
├────────────────────────────────────────────────────┤
│  .af/output/                                       │
│  ├── AF-51/          2 hrs ago                     │
│  │   └── result.md                                 │
│  ├── AF-50/          1 day ago                     │
│  │   ├── result.md                                 │
│  │   └── AF-50-qa-verdict.md                       │
│  …                                                 │
│                                                    │
│  [Click a file to preview]                         │
└────────────────────────────────────────────────────┘
```

Tree view using Shadcn's `Collapsible` component. Clicking a `.md` file opens a side-by-side preview panel (rendered markdown, same `react-markdown` setup already used).

**Phase 2 (later)**: Full workspace file browser with edit capability.

---

## 5. Interaction Patterns

### 5.1 Keyboard Navigation

The application is used intensively by one power user. Full keyboard support is non-negotiable.

**Global shortcuts** (implement with `useEffect` + `keydown` at the layout level):

| Shortcut | Action |
|---|---|
| `Cmd/Ctrl + K` | Open agent search (works from any page) |
| `G T` (sequential) | Go to Tasks |
| `G A` (sequential) | Go to Agents |
| `G C` (sequential) | Go to Chat |
| `G D` (sequential) | Go to Domains |
| `Escape` | Close slide-over or clear search |

**List navigation** (Tasks, Agents):

| Key | Action |
|---|---|
| `↑/↓` | Move through rows |
| `Enter` | Open selected row (slide-over or profile) |
| `/` | Focus search input |
| `Escape` | Close slide-over, return focus to list |
| `N` | Create new (when supported) |

**Focus management rules:**
- Opening a slide-over: move focus to the first interactive element inside it
- Closing a slide-over: return focus to the row that triggered it (or the row above if deleted)
- Opening a dialog: trap focus inside (`aria-modal="true"`)
- Tab order: left-to-right, top-to-bottom. Sidebar → Main content → Right panel

### 5.2 Selection and Detail Patterns

Two patterns are used in this UI — choose based on screen size and complexity of detail:

**Right panel** (Agents list, large screens):
- Selection shows detail in a persistent right panel
- Panel is always the same width (384px / `w-96`)
- Multiple rows can be visited without panel closing
- Panel close button (×) returns to unselected state

**Slide-over** (Tasks, Domains trigger):
- Animated from right edge, overlays content with scrim
- Width: 480–560px depending on content density
- Keyboard: Escape closes it
- Backdrop click closes it

**Full-page navigation** (future: task detail `/tasks/AF-52`):
- Use when the detail view is complex enough to warrant its own URL
- Currently: not needed. The slide-over is sufficient.

### 5.3 Loading States

**Principle**: Show skeleton immediately (0ms delay). Do not show spinners for operations under 200ms — they flash and feel broken.

**Skeleton approach**: Use `animate-pulse bg-muted rounded` shapes that match the layout of the actual content. Never use a single centered spinner for a full-page load.

**Rule for buttons**:
- Show spinner inside the button when an action takes >200ms (save, run orchestration)
- Disable the button during the action
- Never remove the button during the action (avoid layout shift)

**Optimistic updates** (future enhancement):
- When moving a task status, update the UI immediately, then confirm with the API
- On error: revert the optimistic update and show an inline error

### 5.4 Error States

**Taxonomy** (each type needs a distinct visual treatment):

| Error type | Visual | Example |
|---|---|---|
| Validation error (form) | Red helper text below the field | "Endpoint must be localhost or 127.0.0.1" |
| Action error (save failed) | Toast notification, top-right | "Failed to save agent: permission denied" |
| Page load error | Inline within the page area | "Failed to load agents. Retry ↻" |
| Network offline | Banner at top of layout | "Connection lost — changes may not save" |
| Empty state | Descriptive message + next step | "No tasks yet. Create one with `af task create`" |

**Toast spec** (Shadcn `Sonner` or equivalent):
- Position: bottom-right (away from the right panel to avoid overlap)
- Duration: 4000ms for info/success, 8000ms for errors
- Max stack: 3 toasts visible

---

## 6. Responsive Breakpoint Strategy

### Breakpoints

| Name | Min-width | Tailwind prefix | Use case |
|---|---|---|---|
| sm | 640px | `sm:` | Tablet portrait |
| md | 768px | `md:` | Tablet landscape, small laptop |
| lg | 1024px | `lg:` | Standard laptop |
| xl | 1280px | `xl:` | Large laptop, desktop |
| 2xl | 1536px | `2xl:` | Wide desktop |

### Per-page strategy

**Chat page:**
- All breakpoints: full-height, tab bar stays, no layout change needed

**Agents page:**
- `<768px`: List only, full-width. Clicking a row navigates to `/agents/[slug]` (full-page profile)
- `768–1279px`: List full-width, profile opens as `Sheet` (drawer from right)
- `≥1280px`: List + right panel side-by-side (current approach but redesigned as list)

**Tasks page:**
- `<768px`: List with fewer columns visible (TICKET, TITLE, STATUS dot). Hide ASSIGNEE and PRIORITY columns — they're shown in the slide-over.
- `768px+`: Full column set
- Slide-over: `w-[90vw]` on mobile, `w-[480px]` on md+

**Domains / Orchestration:**
- `<768px`: Cards stack vertically, full-width. Slide-over becomes full-screen modal.
- `768px+`: Two-column grid of domain cards

**Projects:**
- All breakpoints: Single column list (projects aren't a grid — they're a prioritized list)

**Sidebar:**
- `<1024px`: Sidebar collapses to icon-only by default. User can expand with toggle.
- `≥1024px`: Sidebar expanded by default (shows labels).

---

## 7. Accessibility Checklist (WCAG AA)

### Color Contrast

| Pair | Ratio | Status |
|---|---|---|
| `foreground` on `background` (oklch 0.145 on 1.0) | ~14:1 | ✅ Pass |
| `muted-foreground` on `background` (oklch 0.556 on 1.0) | ~5.5:1 | ✅ Pass |
| `primary-foreground` on new `primary` (near-white on amber-dark) | ~7:1 | ✅ Pass |
| `destructive` text on `background` | ~4.8:1 | ✅ Pass |
| Status-active green on white | ~4.5:1 | ✅ Pass (verify with APCA) |
| Amber accent (`--accent-warm`) on white | ~3.2:1 | ⚠ Large text only (18px+) |
| Small text on `--accent-warm` background | Use `oklch(0.145 0 0)` dark | ✅ |

**Note on amber accent**: `--accent-warm` at `oklch(0.76 0.13 75)` fails 4.5:1 for small text on white. Do **not** use it as a text color for body copy. Use it only for:
1. Active border/ring states (no text contrast concern)
2. Background of pills/badges with dark text
3. Large decorative elements where 3:1 is sufficient

### Focus states

Every interactive element must have a visible focus state. Replace the current default ring with the amber focus ring:

```css
:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px oklch(0.76 0.13 75 / 0.40);
}
```

This creates a distinctive, brand-consistent focus ring that passes 3:1 against both light and dark backgrounds.

### Screen reader considerations

- All interactive list rows: `role="row"` if in a `role="grid"`, or just `<button>` elements if simpler
- Status dots: `aria-label="Status: in-progress"` — colors alone don't communicate
- Priority dots: `aria-label="Priority: high"`
- Skeleton loading regions: `aria-busy="true"` on the container, `aria-label="Loading agents"`
- Slide-over: `role="dialog"` with `aria-labelledby` pointing to the slide-over title, `aria-modal="true"`
- Tab bar (chat): `role="tablist"`, `role="tab"`, `aria-selected`, `role="tabpanel"`
- Icon-only buttons: always have `title` and `aria-label`

### Keyboard traps

- Modal/slide-over: trap focus (`focus-trap` library or manual Tab/Shift+Tab interception)
- On close: return focus to the trigger element
- Sidebar in collapsed state (icon-only): icons must still be keyboard reachable and labeled

### Headings hierarchy

Each page must have exactly one `<h1>`. Current pages violate this in some places:
- `AgentsPage` uses `<h1 className="text-xl font-semibold">Agents</h1>` — correct
- `ProjectsPage` uses `<h1 className="text-2xl font-bold">Projects</h1>` — correct but size inconsistency vs Agents page (2xl vs xl)

**Standardize**: All page `<h1>` at `text-xl font-semibold`. Consistency over ad-hoc sizing.

---

## 8. Design Decisions — Non-Obvious Choices

### 8.1 Amber primary instead of black

**Decision**: Change `--primary` from pure near-black to warm amber.

**Reasoning**: Pure black primary is technically correct and maximally accessible, but it creates no visual identity. Every other Shadcn app uses the same grayscale system. One warm color token creates a lasting impression without violating any principle. Amber specifically reads as "deliberate," "golden," "intelligent" — vs blue ("tech startup") or green ("success/action"). The amber is not decorative — it marks interactive elements and active states. Every amber pixel communicates "this is where you act."

### 8.2 List over cards for Agents

**Decision**: Replace card grid with row list.

**Reasoning**: Cards imply rich preview content. An agent card has: name, role, two metadata chips, two icon buttons. That's 5 data points. A list row holds 5 data points with 60% less chrome. At 25+ agents, the card grid requires 2–3x more scrolling. The power user who visits this page 5x/day will notice. Cards stay where they earn their place (Projects page, Domain cards).

### 8.3 Slide-over for task detail, not navigation

**Decision**: Task detail as a slide-over, not a full-page route.

**Reasoning**: The primary workflow is "scan many tasks, read a few." If each task navigates to a new page, the back button becomes a crutch and the scanning flow breaks. A slide-over keeps the task list visible and context-present. The user can close it instantly with Escape. It also avoids building a separate page route with URL state management at this stage — the slide-over is simpler to implement and faster to use.

### 8.4 No kanban for Tasks

**Decision**: Table list, not kanban board.

**Reasoning**: Kanban makes sense when tasks are actively moved through stages by multiple people in real time, and when visual column comparison is useful. AF-52 has ~47 tasks across 9 statuses. A kanban board with 9 columns and 47 tasks is information soup — you can't see everything at once, and dragging cards between tiny columns is worse than a status dropdown. The status pipeline header (clickable filter pills) gives the same "how many in each status?" insight without the spatial confusion. Power user benefits: keyboard navigation, sorting, density.

### 8.5 Tasks before Projects in nav

**Decision**: Navigation order: Chat → Tasks → Projects → Agents → Orchestrate → Files.

**Reasoning**: Navigation order should reflect frequency + importance. The primary user checks tasks constantly (they are the core artifact of AF). Projects contextualize tasks but are visited less. Agents are visited when something needs to be edited. This order reflects actual usage, not "what sounds logical to a new user."

---

## 9. Open Questions for the Frontend Engineer

1. **Tasks API**: Does `/api/projects/:id/tasks` exist? Does it support filtering by status, assignee, priority? If not, this needs to be built alongside the Tasks page.

2. **Orchestration API**: Does `/api/orchestrate` exist (from the AF-48 work)? What is its request/response shape? The Domains slide-over depends on this.

3. **Virtual scrolling**: At 50+ agents, do we expect performance issues with a list? If yes, integrate `@tanstack/react-virtual` now. If agent count stays under 30, a plain `<ul>` is fine.

4. **Toast library**: There's no toast/notification system currently. `sonner` is the recommended pairing with Shadcn. Add it? Or use Shadcn's built-in `Toaster`?

5. **Files API**: For the minimal Files page (Phase 1), does the API support listing `.af/output/` contents? If not, add a simple GET `/api/files?path=.af/output` that returns a file tree.

6. **`cmdk` package**: The package.json includes `cmdk` (command menu). This could power the global `Cmd+K` search. Is it currently wired to anything? If not, wire it to agent search.

---

## 10. Audit Completion Checklist

- [x] All 5 existing sections audited (Chat, Projects, Agents, Domains, Files)
- [x] Design tokens specified with concrete OKLCH values
- [x] Agents page: list layout specified with all states (loading, empty, hover, selected, keyboard-focused, 0 items, 50+ items)
- [x] Tasks page: new component fully specified with all states
- [x] Chat page: empty state redesigned, interaction improvements listed
- [x] Domains page: orchestration trigger specified with all states
- [x] Projects page: list redesign specified
- [x] Files page: Phase 1 plan specified
- [x] Responsive breakpoints defined per page
- [x] Color contrast verified for WCAG AA (amber primary flagged for large-text-only on white)
- [x] Focus states specified
- [x] Screen reader attributes listed
- [x] Keyboard navigation patterns defined
- [x] All non-obvious decisions documented with reasoning
- [x] Open questions for the engineer documented

---

*Design by ux-designer · AF-52 · 2026-06-02*

<!-- AUDIT: AF-52 UX design complete. Delivered: design tokens (amber primary accent, semantic status/priority colors, type scale, spacing, shadow tokens, motion tokens), information architecture (added Tasks to nav, reordered for frequency-of-use), component specs for 6 pages with all states documented, responsive strategy per breakpoint per page, WCAG AA accessibility checklist with contrast ratios, keyboard shortcut map, 4 non-obvious design decisions with rationale, 6 open questions for the frontend engineer. No blue/purple AI cliché colors used. Cards removed from Agents in favor of list. New Tasks view is the most impactful addition — it exposes the core AF feature that was completely absent from the web UI. -->
