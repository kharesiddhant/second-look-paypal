import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, validSession } from '@/lib/auth';

// Optimistic page check: signed-out visitors are sent to /login. API routes verify the session themselves.
export function proxy(req: NextRequest) {
  if (validSession(req.cookies.get(SESSION_COOKIE)?.value)) return NextResponse.next();
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = {
  matcher: ['/((?!api|login|_next/static|_next/image|favicon.ico).*)'],
};
