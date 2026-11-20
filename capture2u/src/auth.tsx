import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { ApiRequestError, api, getSupabase } from "./lib/api";

export interface CurrentUser {
	id: string;
	email: string;
	role: "member" | "admin";
	fullName: string | null;
}

interface AuthState {
	loading: boolean;
	user: CurrentUser | null;
	error: string | null;
	signIn: (returnTo?: string) => Promise<void>;
	signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
	const [loading, setLoading] = useState(true);
	const [user, setUser] = useState<CurrentUser | null>(null);
	const [error, setError] = useState<string | null>(null);

	const loadUser = useCallback(async (hasSession: boolean) => {
		if (!hasSession) {
			setUser(null);
			setLoading(false);
			return;
		}
		try {
			const result = await api<{ user: CurrentUser }>("/api/me");
			setUser(result.user);
			setError(null);
		} catch (cause) {
			setUser(null);
			if (
				cause instanceof ApiRequestError &&
				cause.code === "domain_not_allowed"
			) {
				setError(
					"Capture2u is only for company email addresses. Sign in with your work Google account.",
				);
				const supabase = await getSupabase();
				await supabase.auth.signOut();
			} else if (!(cause instanceof ApiRequestError && cause.status === 401)) {
				setError("Could not load your account. Please try again.");
			}
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		let unsubscribe: (() => void) | undefined;
		let cancelled = false;
		getSupabase()
			.then(async (supabase) => {
				const { data } = await supabase.auth.getSession();
				if (cancelled) return;
				await loadUser(Boolean(data.session));
				const subscription = supabase.auth.onAuthStateChange(
					(event, session) => {
						if (event === "SIGNED_IN" || event === "SIGNED_OUT")
							void loadUser(Boolean(session));
					},
				);
				unsubscribe = () => subscription.data.subscription.unsubscribe();
			})
			.catch((cause: unknown) => {
				if (cancelled) return;
				setError(
					cause instanceof Error ? cause.message : "Sign-in is unavailable",
				);
				setLoading(false);
			});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [loadUser]);

	const signIn = useCallback(async (returnTo?: string) => {
		const supabase = await getSupabase();
		const target = new URL(returnTo ?? "/", window.location.origin);
		const { error: signInError } = await supabase.auth.signInWithOAuth({
			provider: "google",
			options: { redirectTo: target.toString() },
		});
		if (signInError) setError(signInError.message);
	}, []);

	const signOut = useCallback(async () => {
		const supabase = await getSupabase();
		await supabase.auth.signOut();
		setUser(null);
	}, []);

	const value = useMemo(
		() => ({ loading, user, error, signIn, signOut }),
		[loading, user, error, signIn, signOut],
	);
	return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
	const context = useContext(AuthContext);
	if (!context) throw new Error("useAuth must be used inside AuthProvider");
	return context;
}
