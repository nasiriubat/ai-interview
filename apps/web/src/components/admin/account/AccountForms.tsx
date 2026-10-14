"use client";

import { LogOutIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import * as React from "react";
import { z } from "zod";
import { FormSection, TextField } from "@/components/admin/forms";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { notify } from "@/components/common/notify";
import { useLocaleSwitch } from "@/components/common/useLocaleSwitch";
import { ReadOnlyField, RadioField } from "@/components/form/controls";
import { Form } from "@/components/form/Form";
import { useForm } from "@/components/form/useForm";
import { Button } from "@/components/ui/button";
import { t } from "@/i18n";
import { LOCALES, type Locale } from "@/i18n/locale";
import { staffClient } from "@/lib/api/browser";
import type { Me } from "@/lib/api/schemas";
import { applyTheme, readTheme, type ThemeChoice } from "@/lib/theme";

const schema = z.object({ name: z.string().max(120) });

/** Everything on the account page that changes something: name, appearance, sessions. */
export function AccountForms({
  me,
  signOutAction,
}: {
  me: Me;
  signOutAction: () => Promise<void>;
}): React.JSX.Element {
  const k = t.kit.account;
  const router = useRouter();
  const form = useForm({
    id: "account",
    initial: { name: me.user.name ?? "" },
    schema,
    labels: { name: k.name },
    savedText: k.saved,
    onSubmit: async (v) => {
      await staffClient.updateProfile({ name: v.name.trim() === "" ? null : v.name.trim() });
      router.refresh();
    },
  });
  const { shown, change } = useLocaleSwitch();
  const [theme, setTheme] = React.useState<ThemeChoice>("system");
  React.useEffect(() => {
    setTheme(readTheme());
  }, []);
  const [confirm, setConfirm] = React.useState(false);
  const [revoking, setRevoking] = React.useState(false);
  const signOutForm = React.useRef<HTMLFormElement>(null);

  return (
    <div className="grid max-w-3xl gap-5">
      <Form form={form} saveLabel={k.save}>
        <FormSection id="profile" title={k.profile}>
          <p className="text-muted-foreground -mt-2 text-sm">{k.profileHelp}</p>
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <TextField
              {...form.field("name")}
              label={k.name}
              placeholder={k.namePlaceholder}
              autoComplete="name"
              maxLength={120}
            />
            <ReadOnlyField id="account-email" label={k.email} value={me.user.email} hint={k.emailHelp} />
            <ReadOnlyField id="account-role" label={k.role} value={t.admin.nav.role[me.user.role]} />
            {me.company ? (
              <ReadOnlyField id="account-org" label={k.organization} value={me.company.name} />
            ) : null}
          </div>
        </FormSection>
      </Form>

      <FormSection id="preferences" title={k.preferences}>
        <p className="text-muted-foreground -mt-2 text-sm">{k.preferencesHelp}</p>
        <div className="grid gap-6 sm:grid-cols-2">
          <RadioField<Locale>
            id="account-language"
            label={k.language}
            value={shown}
            options={LOCALES.map((l) => ({ value: l, label: t.app.languageNames[l] }))}
            onChange={change}
          />
          <RadioField<ThemeChoice>
            id="account-theme"
            label={k.theme}
            value={theme}
            options={[
              { value: "system", label: t.app.theme.system },
              { value: "light", label: t.app.theme.light },
              { value: "dark", label: t.app.theme.dark },
            ]}
            onChange={(v) => {
              setTheme(v);
              applyTheme(v);
            }}
          />
        </div>
      </FormSection>

      <FormSection id="signin" title={k.signInTitle}>
        <p className="text-body text-sm leading-relaxed">{k.signInBody}</p>
      </FormSection>

      <FormSection id="sessions" title={k.sessionsTitle}>
        <p className="text-body text-sm leading-relaxed">{k.sessionsBody}</p>
        <div className="flex flex-wrap gap-2">
          <form ref={signOutForm} action={signOutAction}>
            <Button type="submit" variant="outline">
              <LogOutIcon aria-hidden="true" /> {k.signOut}
            </Button>
          </form>
          <Button
            variant="destructive"
            onClick={() => {
              setConfirm(true);
            }}
          >
            {k.signOutAll}
          </Button>
        </div>
      </FormSection>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={k.signOutAllTitle}
        description={<p>{k.signOutAllBody}</p>}
        confirmLabel={k.signOutAllConfirm}
        pending={revoking}
        onConfirm={() => {
          setRevoking(true);
          staffClient
            .revokeOwnSessions()
            .then(() => {
              signOutForm.current?.requestSubmit();
            })
            .catch((e: unknown) => {
              setRevoking(false);
              notify.error(e);
            });
        }}
      />
    </div>
  );
}
