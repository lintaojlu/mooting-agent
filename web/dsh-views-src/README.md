# DSH view reuse

The compiled `web/dsh-views.js` / `web/dsh-views.css` are self-contained browser artifacts. They do not need the DSH Web shell, client plugin loader, API gateway, or additional Agent Sessions.

## Actual reused implementations

- `@deepseek-ai/dsh-client-ui-trajectory/src/client/TrajectoryTimeline.tsx`: actual three-lane input/model/tool timing chart, selection and drag range.
- `.../TrajectoryTable.tsx`: actual event ledger, turn/assistant/tool folding and local detail inspector.
- `.../layout.ts`, `timeline.ts`, `trajectory-event-projection.ts`: DSH layout, focus calculations and content-block classification.
- `@deepseek-ai/dsh-client-ui-chat/src/client/chat/UserContent.tsx`: actual user bubble content.
- `.../AssistantMarkdown.tsx` / `ReasoningRow.tsx`: actual Markdown/reasoning rendering.
- `.../TurnProcessNodeView.tsx`: actual completed-turn process disclosure.
- `@deepseek-ai/dsh-client-ui-tool/src/client/tool/toolviews/GenericToolCard.tsx`: actual tool summary and disclosure.
- DSH locale dictionaries and theme token sheets; the demo container applies grayscale.

DSH UI plugin `/client` public entries expose plugin `apply` / `inject` and types; component implementations are reached through the permitted `./src/*` source subpaths at build time. No upstream exports or files are modified.

## Demo-owned adaptation

`index.jsx` projects the original `SessionEvent {seq,time,type,data}` array to the typed records consumed by the original DSH layout. It pairs `tool/call` and `tool/result` by call ID, uses step start/end and packed assistant timing when supplied, and ignores unrelated Mooting journal events. The currently active assistant frame is passed separately as `stream`.

The conversation host's ordering and turn grouping are demo-owned. It does not claim to reuse the complete `ChatView`: the full view requires DSH Slots, Session binding, Context-menu, Workspace and other GUI providers. Actual leaf rendering and the process disclosure are reused. Attachments, file navigation, chat forks, historical paging and live RPC tool-result watching are deliberately not implemented.

## Browser API

```js
MootingDSHViews.renderConversation(container, { events, busy, stream });
MootingDSHViews.renderTrajectory(container, { events, busy, stream });
MootingDSHViews.dispose(container);
```

`stream` may be `{attemptId,turn,step,text,reasoning,startedAt}`. Containers own separate React roots but reference the same single DSH session data. Search and time-dimension switching are local presentation state.

## Rebuild and smoke verification

From the demo directory:

```sh
node scripts/build-dsh-views.mjs
node web/dsh-views-src/smoke.mjs
```

Rebuilding requires the adjacent already-installed DSH checkout and its Vite/React dependencies. Running the generated assets does not. The build archives all DSH source inputs it reads under `vendor/dsh-views-source`, retains the DSH MIT license, and writes file SHA256 records to `vendor/dsh-views-manifest.json`.

The standalone Chrome smoke fixture exercises user/assistant/tool rendering, process expansion, three-lane timing, event list and dimension switching. Browser runs completed without JavaScript exceptions. `smoke.png` is a fixture screenshot, not a screenshot of the final five-module application.
