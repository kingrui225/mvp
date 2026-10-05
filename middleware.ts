/**
 * Next.js middleware — runs on every request that matches the config.
 *
 * Responsibilities:
 *  1. Refresh the Supabase session cookie so it stays alive across navigation.
 *  2. Redirect unauthenticated users from protected routes to /login.
 *  3. Redirect already-authed users away from /login back to /search.
 */
import { createServerClient } from '@supabase/ssr'
import { type NextRequest, NextResponse } from 'next/server'

const PUBLIC_ROUTES = ['/login', '/auth/callback', '/auth/confirm']
const PUBLIC_API_ROUTES = ['/api/stripe/webhook']

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          // Propagate cookie mutations to both the request and response so the
          // session refresh is reflected on the next render.
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options),
          )
        },
      },
    },
  )

  // IMPORTANT: Do not run any logic between createServerClient and
  // supabase.auth.getUser(). Doing so can cause issues with session refresh.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { pathname } = request.nextUrl
  const isPublicRoute = PUBLIC_ROUTES.some((p) => pathname.startsWith(p))

  const isPublicApi = PUBLIC_API_ROUTES.some((p) => pathname.startsWith(p))

  // Unauthenticated → redirect to /login (except public pages and Stripe webhook)
  if (!user && !isPublicRoute && !isPublicApi && !pathname.startsWith('/api/')) {
    const loginUrl = request.nextUrl.clone()
    loginUrl.pathname = '/login'
    return NextResponse.redirect(loginUrl)
  }

  // Already authed → redirect away from /login
  if (user && pathname.startsWith('/login')) {
    const searchUrl = request.nextUrl.clone()
    searchUrl.pathname = '/search'
    return NextResponse.redirect(searchUrl)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    /*
     * Match all request paths EXCEPT static files, images, and favicon.
     * This lets _next/static, public assets, and Next internals pass through
     * without running the middleware.
     */
    '/((?!_next/static|_next/image|favicon.ico|apple-icon.png|icon.*\\.(?:svg|png)).*)',
  ],
}
