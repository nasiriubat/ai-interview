import Link from "next/link";
import * as React from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";

export default function NotFound(): React.JSX.Element {
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <h1 className="text-2xl font-semibold">404</h1>
      <p className="text-muted-foreground">{t.app.notFound}</p>
      <Button asChild variant="outline">
        <Link href="/">{t.app.back}</Link>
      </Button>
    </main>
  );
}
