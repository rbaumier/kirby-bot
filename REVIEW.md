# Thermo-Nuclear Code Quality Review

**Branch**: `main` @ `406c910` · **Scope**: tout le projet · **Date**: 2026-05-25

## TL;DR

Codebase en **excellent état** après les refactors récents (vitest→bun:test, GitLab→Provider, handlers split, comply cleanup). Pas de fichier > 1k lignes, pas de spaghetti évident, types serrés, errors taggés.

Findings initiaux : 5. Après vérification fine, **3 réels** + 2 retraits honnêtes.

| Prio | Finding | Lieu | Statut |
|---|---|---|---|
| **P0** | Silent fallback masque un bug duplicate-MR | `pipeline/handlers/pr.ts:25-33` | ✅ Fixé (`c180701`) |
| **P1** | `HandlerError` plumbé avec 3 champs pipeline-state | `pipeline/errors.ts:20-25` | ✅ Fixé (`d7908f7`) |
| **P1** | `runShellAllowingFailure` est de la cérémonie morte | `shell.ts:114-143` | ✅ Fixé (`1ac9045`) |
| ~~P2~~ | ~~`pipelineContext()` est un identity wrapper~~ | `phases/runner.ts:31-37` | ❌ **Retiré** — c'est une projection (drop `kind`+`fixCycles` du spread) |
| ~~P2~~ | ~~`formatDuration` réimplémente `Duration.format`~~ | `pipeline/machine.ts:23-33` | ❌ **Retiré** — `Duration.format` produit `"1m 5s"` ≠ format compact `"1m05s"` voulu pour le log line |

---

## P0 — `findOpenPullRequest` swallow → duplicate Draft MR

**Fichier**: `src/pipeline/handlers/pr.ts:25-33`

```ts
const findOpenPullRequest = (
  branch: string,
): Effect.Effect<Option.Option<PullRequestRef>, never, GitProvider> =>
  Effect.gen(function* () {
    const provider = yield* GitProvider;
    return yield* provider.findOpenPullRequestBySource(branch).pipe(
      Effect.catchAll(() => Effect.succeed(Option.none<PullRequestRef>())),
    );
  });
```

**Le problème** : le `catchAll` mappe **toute** erreur (HTTP 500, timeout, parse error) vers `Option.none()`. Le caller dans `onOpenDraftMr` interprète `None` comme "aucune MR existante" et appelle `createDraftPullRequest(...)`. Sur un blip réseau pendant la phase `open_draft_mr` (par exemple un crash après que `branch_worktree` a déjà été poussé une fois), on créée une **2ème Draft MR** sur la même branche.

L'intention du commentaire `"// open_draft_mr (idempotent), recording its iid"` est cassée par le swallow — l'idempotence ne tient que si on **sait** vraiment qu'aucune MR n'existe. "Je ne peux pas vérifier" n'est pas la même chose que "aucune".

**Fix** : laisser l'erreur remonter et la mapper en `HandlerError` via le mapper standard. Supprime la fonction entière, inline directement dans `onOpenDraftMr` :

```ts
const existing = yield* provider.findOpenPullRequestBySource(branch).pipe(
  Effect.mapError(providerHandlerError("open_draft_mr")),
);
if (Option.isSome(existing)) {
  // reuse path...
}
```

Effet de bord positif : la fn helper `findOpenPullRequest` disparaît (8 lignes), et le `never` channel devient `HandlerError` — cohérent avec le reste du module.

---

## P1 — `HandlerError` carries pipeline-state context

**Fichier**: `src/pipeline/errors.ts:20-25`

```ts
export class HandlerError extends Data.TaggedError("HandlerError")<{
  readonly reason: string;
  readonly branch?: string;
  readonly worktree?: string;
  readonly pullRequestIid?: number;
}> {}
```

Et le merge correspondant dans `pipeline/step.ts:222-225` :
```ts
branch: error.branch ?? base.branch,
worktree: error.worktree ?? base.worktree,
pullRequestIid: error.pullRequestIid ?? base.pullRequestIid,
```

**Le problème** : ces trois champs optionnels existent **uniquement** parce que `onBranchWorktree` (queue.ts:159-167) a calculé `branch` et `worktree` mais le `State` n'a pas encore avancé pour les contenir. Le state model dit "tu es en `branch_worktree`, tu n'as ni branch ni worktree" — mais à mi-handler, c'est faux. L'erreur transporte donc le contexte que le state aurait dû transporter.

C'est un **leak du state model dans le type d'erreur**. La forme propre serait : tant que `HandlerError` est pur (`{ reason: string }`), `failedFieldsOf(state)` est la seule source de vérité pour reconstruire le `failed`.

**Code-judo move** : splitter `branch_worktree` en deux états :

```ts
| { kind: "branch_create"; issue: IssueRef }
| { kind: "branch_push";   issue: IssueRef; branch: string; worktree: string }
```

Après `branch_create` réussi, le state porte naturellement `branch`/`worktree`. Le push échoue → `failedFieldsOf` les lit. Conséquences :
- `HandlerError` redevient `{ reason: string }` (3 champs en moins)
- Le `??` merge dans step.ts disparaît
- `failedFieldsOf` gagne une row, perd 0 (l'ancien `branch_worktree` mappait à `null/null`, maintenant `branch_create` mappe à `null/null` et `branch_push` mappe à `state.branch/state.worktree`)
- L'invariant "le state contient toujours ce que ses champs disent qu'il contient" tient à 100%

Alternative défensive : garder l'état actuel, accepter que `HandlerError` transporte parfois du contexte. C'est ce qu'on a aujourd'hui. Pas faux, mais le state model serait plus propre splitté.

---

## P1 — `runShellAllowingFailure` is dead ceremony

**Fichier**: `src/shell.ts:114-143`

Les 4 call sites :
1. `queue.ts:133` — `git worktree remove --force` (cleanup) → résultat ignoré
2. `queue.ts:134` — `git worktree prune` (cleanup) → résultat ignoré
3. `queue.ts:135` — `git branch -D` (cleanup) → résultat ignoré
4. `pr.ts:148` — `git worktree prune` (cleanup) → résultat ignoré
5. `tmux.ts:48` — `tmux capture-pane` → lit `.stdout` uniquement
6. `tmux.ts:44` — `killSession` via `.pipe(Effect.asVoid)`

**Aucun caller ne lit `exitCode` ni `stderr`**. La fonction folde 3 types d'erreurs distincts (`ShellNonZeroExit`, `ShellTimeout`, `ShellSpawnFailed`) dans un faux `{ exitCode: 1, stdout: "", stderr: ... }` que personne ne consomme. Le `CommandResult` type lui-même n'a qu'un caller — cette fn.

**Code-judo move** : supprimer `runShellAllowingFailure` + `CommandResult`. Remplacer par :

```ts
// cleanup paths (queue.ts, pr.ts, tmux.ts:killSession)
yield* runShell(() => $`git worktree prune`).pipe(Effect.ignore);

// capturePane (tmux.ts) — seul caller qui veut un string
const capturePane = (session: string): Effect.Effect<string> =>
  runShell(() => $`tmux capture-pane -p -t ${session}`).pipe(
    Effect.map((r) => r.stdout),
    Effect.catchAll(() => Effect.succeed("")),
  );
```

Gain : ~30 lignes de fold mort + un type (`CommandResult`) + une API confuse (`exitCode === 1` comme catch-all faux). `Effect.ignore` et `catchAll(succeed(""))` sont les helpers canoniques Effect, lisibles d'un coup d'œil.

---

## P2 — `pipelineContext()` is an identity wrapper

**Fichier**: `src/phases/runner.ts:31-37`

```ts
export const pipelineContext = (state: PipelineContext): PipelineContext => ({
  issue: state.issue,
  branch: state.branch,
  worktree: state.worktree,
  deadline: state.deadline,
  pullRequestIid: state.pullRequestIid,
});
```

Utilisé comme `{ kind: "evaluate", ...pipelineContext(state), fixCycles }`. Cette fn reconstruit la même shape qu'elle reçoit — l'**identité structurelle**.

`...state` direct produirait le même résultat (avec en plus le `kind` de la source que `{ kind: "evaluate", ... }` écrase). Le type `& PipelineContext` sur l'input garantit déjà la présence des champs.

**Argument pour garder** : explicite ce qu'on copie, défense contre l'ajout silencieux d'un champ sur `PipelineContext` qui se propagerait via spread.

**Argument pour supprimer** : abstraction qui ne supprime rien, juste 5 lignes de boilerplate à chaque modification du modèle de state. La défense "spread leaks" est marginale dans un codebase TS strict.

**Mon verdict** : skip si tu y tiens. Si tu veux maximiser la lisibilité, supprime et utilise le spread direct.

---

## P2 — `formatDuration` réimplémente `Duration.format`

**Fichier**: `src/pipeline/machine.ts:22-33`

11 lignes manuelles pour formater des ms en `1m05s` / `4.2s` / `850ms`. Effect ships `Duration.format` et `Duration.millis(ms)` — la transformation est un one-liner :

```ts
const formatDuration = (ms: number): string => Duration.format(Duration.millis(ms));
```

Vérifier que `Duration.format` produit la forme exacte voulue (Effect propose plusieurs styles). Si oui, gain net de 10 lignes et reuse du helper canonique.

Si la forme exacte n'est pas dispo, garder le hand-rolled est acceptable mais le commentaire devrait dire pourquoi.

---

## Findings examinés et écartés (non-blocking)

Pour transparence, voici les zones examinées sans finding actionnable :

- **`pipeline/state.ts`** — Le discriminated union est propre. La mixité `& PipelineContext` vs champs explicites reflète une vraie frontière de données (pas une inconsistance).
- **`verdict.ts:parseVerdict`** — Strict by design, biais false-fail > false-proceed bien argumenté. Tests exhaustifs.
- **`provider/types.ts`** — 4 tagged errors distincts, mappage `describe...` exhaustif. Boundary clean.
- **`gitlab/schema.ts`** — `MrStateSchema` avec coercion safe vers `"opened"` pour les inconnus est défendable (survie aux nouveaux états serveur).
- **`gitlab/discussion.ts`** — Parsing défensif de JSON externe, le seul endroit où `unknown` est légitime.
- **`phases/*` modules** — Chacun fait une chose. ~25-50 lignes chacun.
- **`session/phase.ts:runPhaseSession`** — `acquireUseRelease` autour de la session tmux est la bonne abstraction. Le bracket garantit que `killSession` tourne sur chaque exit path.
- **`session/tmux.ts:waitForTuiReady`** — Polling à stabilité de 2 ticks consécutifs est un design choisi sur un blind sleep ; argumenté.
- **`config.ts`** — Pures constantes, aucune logique. Forme idéale d'un fichier de config.
- **`pipeline/naming.ts`** — Pures transformations de string, testable trivialement.
- **`run-artifacts.ts`** — Service Effect propre, layer-pattern bien appliqué.
- **`pipeline/handlers/queue.ts:onBranchWorktree`** — 60 lignes pour 6 étapes (mkdir, cleanup, fetch, add, exclude, push). Touchant la limite de "trop dense" mais chaque étape a un seul `mapError` typé. Pas de splitage urgent.
- **`pipeline/step.ts`** — Le guard L215-218 dans le `catchAll` est défensif sur un path en réalité unreachable (TS narrowing ne peut le prouver à cause de la signature de `step`). Acceptable.

---

## Approval bar

| Critère | Verdict |
|---|---|
| Régression structurelle | ❌ aucune |
| Opportunité de simplification dramatique manquée | ⚠️ une seule, P1 (`runShellAllowingFailure`) |
| Explosion de taille de fichier | ❌ max 385 lignes (http.ts) |
| Spaghetti de branching ad-hoc | ❌ aucune |
| Abstraction hacky / magique | ❌ aucune |
| Wrapper / cast / optionality inutile | ⚠️ P2 `pipelineContext()` + P1 optionals sur `HandlerError` |
| Boundary architecture leak | ⚠️ P1 `HandlerError` (state-model leak) |
| Décomposition obvious manquée | ❌ aucune |

**Verdict global** : à approuver après fix du **P0** (`findOpenPullRequest`). Les P1/P2 sont des améliorations de qualité à intégrer dans un prochain refactor — pas des blockers.
