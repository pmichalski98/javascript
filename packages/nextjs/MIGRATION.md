# Migration guide

The upcoming major version of `@clerk/nextjs` includes several breaking changes to public SDK methods. Here is the summary of the breaking changes and how to address them in your own codebase.

## auth() is now async

Previously the `auth()` method from `@clerk/nextjs/server` was synchronous.

```typescript
import { auth } from '@clerk/nextjs/server';

export function GET() {
  const { userId } = auth();
  return new Response(JSON.stringify({ userId }));
}
```

The method now becomes asynchronous. You will need to make the following changes to the snippet above to make it compatible.

```diff
- export function GET() {
+ export async function GET() {
-   const { userId } = auth();
+   const { userId } = await auth();
  return new Response(JSON.stringify({ userId }));
}
```
