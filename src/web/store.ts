import { useSyncExternalStore } from "react";
import { api, post, setUnauthorizedHandler } from "./api";

export type User = { id: number; username: string; fullName: string; role: string; storeId?: number; permissions: string[] };
type Auth = { status: "loading" | "in" | "out"; user: User | null; mustChange: boolean };
let state: Auth = { status: "loading", user: null, mustChange: false };
const subs = new Set<() => void>();
const set = (s: Partial<Auth>) => { state = { ...state, ...s }; subs.forEach((f) => f()); };
const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export const useAuth = () => useSyncExternalStore(subscribe, () => state);
export const can = (p: string) => !!state.user?.permissions.includes(p);
export const useCan = () => { const a = useAuth(); return (...p: string[]) => p.some((x) => a.user?.permissions.includes(x)); };

const mcp = () => { try { return sessionStorage.getItem("hm_mcp") === "1"; } catch { return false; } };
export async function loadMe() {
  try {
    const me = await api<User>("/api/auth/me", { silent: true });
    set({ status: "in", user: me, mustChange: mcp() });
  } catch { set({ status: "out", user: null }); }
}
export async function login(username: string, password: string, deviceId: string) {
  const r = await post<{ mustChangePassword: boolean }>("/api/auth/login", { username, password, deviceId });
  try { sessionStorage.setItem("hm_mcp", r.mustChangePassword ? "1" : "0"); } catch {}
  await loadMe();
}
export async function changePassword(current: string, next: string) {
  await post("/api/auth/change-password", { current, next });
  try { sessionStorage.setItem("hm_mcp", "0"); } catch {}
  set({ mustChange: false });
}
export async function logout() {
  try { await post("/api/auth/logout", {}, { silent: true }); } catch {}
  set({ status: "out", user: null });
}
setUnauthorizedHandler(() => set({ status: "out", user: null }));
