interface QuitRequest { token: string; windowLabel: string; restart?: boolean }
type Unlisten = () => void;
export type WindowListener = <T>(name: string, callback: (event: {payload: T}) => void, options: {target: string}) => Promise<Unlisten>;

/** An unrestricted Tauri listener receives targeted events for other windows too. */
export async function installWindowEvents(label: string, handlers: { quit: (token: string, restart?: boolean) => void; about: () => void; updates: () => void }, listen: WindowListener): Promise<Unlisten[]> {
  const options = { target: label };
  return [
    await listen<QuitRequest>("prepare-quit", event => {
      if (event.payload?.windowLabel === label && typeof event.payload.token === "string") handlers.quit(event.payload.token, event.payload.restart === true);
    }, options),
    await listen("show-about", handlers.about, options),
    await listen("check-updates", handlers.updates, options),
  ];
}
