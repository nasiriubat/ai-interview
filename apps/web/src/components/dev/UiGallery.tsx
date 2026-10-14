"use client";

import { PencilIcon, PlusIcon, Trash2Icon } from "lucide-react";
import * as React from "react";
import { z } from "zod";
import { SelectField, SwitchField, TextAreaField, TextField, FormSection } from "@/components/admin/forms";
import { IconButton, RowActions } from "@/components/admin/IconButton";
import { StatusBadge } from "@/components/admin/StatusBadge";
import { ConfirmDialog } from "@/components/common/ConfirmDialog";
import { notify } from "@/components/common/notify";
import { DataTable, DataTableSkeleton, useTableSelection } from "@/components/data/DataTable";
import { ImportDialog } from "@/components/data/ImportDialog";
import {
  CheckboxField,
  DateField,
  RadioField,
  ReadOnlyField,
  SecretField,
  UnitField,
} from "@/components/form/controls";
import { Form } from "@/components/form/Form";
import { useForm } from "@/components/form/useForm";
import { Button } from "@/components/ui/button";
import { FileUpload } from "@/components/upload/FileUpload";
import { ApiError } from "@/lib/api/errors";

/**
 * Every state of every primitive of the UI kit on one page (D-348). It exists for review and for
 * the visual tests: dev and e2e builds only (`UI_GALLERY=1`), never in production.
 */
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4">
      <h2 id={`${id}-h`} className="border-b pb-2 text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

const rows = Array.from({ length: 5 }, (_v, i) => ({
  id: `r${String(i)}`,
  label: `Row ${String(i + 1)}`,
  cells: {
    name: `Sample row ${String(i + 1)}`,
    status: <StatusBadge status={["open", "draft", "closed", "analyzing", "open"][i] ?? "open"} />,
    count: String((i + 1) * 12),
  },
  actions: (
    <RowActions>
      <IconButton label={`Edit row ${String(i + 1)}`} icon={<PencilIcon />} onClick={() => undefined} />
      <IconButton
        label={`Delete row ${String(i + 1)}`}
        icon={<Trash2Icon />}
        className="text-destructive"
        onClick={() => undefined}
      />
    </RowActions>
  ),
}));
const columns = [
  { id: "name", header: "Name", primary: true, locked: true },
  { id: "status", header: "Status" },
  { id: "count", header: "Count", align: "end" as const },
];

function BulkDemo(): React.JSX.Element {
  const sel = useTableSelection();
  return (
    <Button size="sm" variant="outline" onClick={sel.clear}>
      Archive {sel.ids.length}
    </Button>
  );
}

const schema = z.object({
  name: z.string().min(2),
  days: z.number().min(1).max(365),
  notes: z.string().max(200),
});

export function UiGallery(): React.JSX.Element {
  const [confirm, setConfirm] = React.useState<"plain" | "typed" | null>(null);
  const form = useForm({
    id: "gallery",
    initial: { name: "Ward round", days: 30, notes: "" } as { name: string; days: number | ""; notes: string },
    schema,
    labels: { name: "Name", days: "Retention", notes: "Notes" },
    onSubmit: async () => {
      await wait(600);
    },
  });
  const [secret, setSecret] = React.useState("");
  const [radio, setRadio] = React.useState<"a" | "b">("a");
  const [sw, setSw] = React.useState(true);
  const [sel, setSel] = React.useState<"x" | "y" | "">("");

  return (
    <div className="mx-auto grid max-w-5xl grid-cols-[minmax(0,1fr)] gap-10 p-4 sm:p-6">
      <h1 className="text-2xl font-semibold">UI kit gallery</h1>

      <Section id="buttons" title="Buttons and icon buttons">
        <div className="flex flex-wrap items-center gap-2">
          <Button>Primary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button loading>Pending</Button>
          <Button disabled>Disabled</Button>
          <IconButton label="Add item" icon={<PlusIcon />} onClick={() => undefined} />
          <IconButton
            label="Delete item"
            icon={<Trash2Icon />}
            className="text-destructive"
            onClick={() => undefined}
          />
          <IconButton label="Disabled action" icon={<PencilIcon />} disabled onClick={() => undefined} />
        </div>
      </Section>

      <Section id="forms" title="Form kit">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            id="g-text"
            label="Text field"
            value="Hello"
            onChange={() => undefined}
            hint="A hint under the field."
          />
          <TextField
            id="g-err"
            label="With an error"
            value=""
            required
            error="This field is required."
            onChange={() => undefined}
          />
          <TextField id="g-dis" label="Disabled" value="Cannot edit" disabled onChange={() => undefined} />
          <ReadOnlyField id="g-ro" label="Read only" value="owner@acme.test" hint="Set by the platform." />
          <TextAreaField id="g-ta" label="Textarea" value="" optional onChange={() => undefined} />
          <SelectField
            id="g-sel"
            label="Select"
            value={sel}
            placeholder="Choose…"
            options={[
              { value: "x", label: "Option X" },
              { value: "y", label: "Option Y" },
            ]}
            onChange={setSel}
          />
          <UnitField id="g-unit" label="Number with unit" value={30} unit="days" onChange={() => undefined} />
          <SecretField id="g-secret" label="Secret" value={secret} isSet onChange={setSecret} />
          <DateField id="g-date" label="Date" value="2026-10-14" onChange={() => undefined} />
          <SwitchField id="g-sw" label="Switch" checked={sw} onChange={setSw} hint="Takes effect at once." />
          <CheckboxField id="g-cb" label="Checkbox" hint="With a hint." checked onChange={() => undefined} />
          <RadioField
            id="g-radio"
            label="Radio group"
            value={radio}
            options={[
              { value: "a", label: "Option A", hint: "What A means." },
              { value: "b", label: "Option B" },
            ]}
            onChange={setRadio}
          />
        </div>
        <Form form={form} bar>
          <FormSection id="gallery-form" title="A form with validation and a save bar">
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField {...form.field("name")} label="Name" required />
              <UnitField {...form.field("days")} label="Retention" unit="days" min={1} max={365} />
            </div>
            <TextAreaField {...form.field("notes")} label="Notes" optional />
          </FormSection>
        </Form>
      </Section>

      <Section id="dialogs" title="Confirmations and toasts">
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setConfirm("plain");
            }}
          >
            Confirm dialog
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setConfirm("typed");
            }}
          >
            Typed confirmation
          </Button>
          <Button variant="outline" onClick={() => notify.success("Saved")}>
            Success toast
          </Button>
          <Button variant="outline" onClick={() => notify.info("Heads up")}>
            Info toast
          </Button>
          <Button
            variant="outline"
            onClick={() =>
              notify.error(new ApiError(500, "internal", "The server said no"), { retry: () => undefined })
            }
          >
            Error toast with retry
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              void notify
                .promise(wait(1500), { loading: "Working…", success: "Done" })
                .catch(() => undefined);
            }}
          >
            Promise toast
          </Button>
          <Button variant="outline" onClick={() => notify.undo("Item removed", () => undefined)}>
            Undo toast
          </Button>
        </div>
        <ConfirmDialog
          open={confirm === "plain"}
          onOpenChange={(o) => {
            if (!o) setConfirm(null);
          }}
          title="Delete this item?"
          description={<p>It is removed for everyone and cannot be brought back.</p>}
          confirmLabel="Delete item"
          onConfirm={() => undefined}
        />
        <ConfirmDialog
          open={confirm === "typed"}
          onOpenChange={(o) => {
            if (!o) setConfirm(null);
          }}
          title="Delete the organization?"
          description={<p>All campaigns and interviews go with it.</p>}
          confirmLabel="Delete organization"
          confirmPhrase="Acme Care"
          onConfirm={() => undefined}
        />
      </Section>

      <Section id="upload" title="File upload and import">
        <FileUpload
          multiple
          accept={["application/pdf", ".docx", "image/png"]}
          maxSizeMb={5}
          label="Choose files"
          upload={async (file, ctx) => {
            // Name a file "fail" or "full" to see the two kinds of refusal.
            for (let p = 0; p <= 100; p += 20) {
              if (ctx.signal.aborted) throw new DOMException("Aborted", "AbortError");
              ctx.onProgress(p);
              await wait(250);
            }
            if (file.name.startsWith("full")) throw new ApiError(507, "storage_full", "Storage full");
            if (file.name.startsWith("fail")) throw new ApiError(0, "network_error", "offline");
            return file.name;
          }}
        />
        <div className="flex items-center gap-2">
          <ImportDialog
            trigger="Import addresses"
            title="Import addresses"
            description="One address per line."
            accept={[".txt", ".csv"]}
            onImport={(r) => notify.success(`${String(r.length)} imported`)}
          />
          <span className="text-muted-foreground text-sm">Import dialog</span>
        </div>
      </Section>

      <Section id="tables" title="Data table states">
        <h3 className="font-medium">Ready, with selection</h3>
        <DataTable
          id="gallery-ready"
          label="Gallery"
          columns={columns}
          rows={rows}
          selectable
          bulkActions={<BulkDemo />}
          searchLabel="Search rows"
          filters={[
            {
              type: "select",
              key: "status",
              label: "Status",
              options: [
                { value: "open", label: "Open" },
                { value: "closed", label: "Closed" },
              ],
            },
          ]}
          page={{ page: 1, limit: 50, count: rows.length, total: rows.length }}
        />
        <h3 className="font-medium">Loading</h3>
        <DataTableSkeleton columns={3} rows={3} />
        <h3 className="font-medium">Empty</h3>
        <DataTable
          id="gallery-empty"
          label="Empty"
          columns={columns}
          rows={[]}
          empty={{
            title: "No items yet",
            description: "Create the first one to see it here.",
            action: <Button size="sm">Create item</Button>,
          }}
          page={{ page: 1, limit: 50, count: 0, total: 0 }}
        />
        <h3 className="font-medium">Error</h3>
        <DataTable
          id="gallery-error"
          label="Error"
          columns={columns}
          rows={[]}
          error="The server did not answer in time."
          page={{ page: 1, limit: 50, count: 0, total: null }}
        />
      </Section>
    </div>
  );
}
