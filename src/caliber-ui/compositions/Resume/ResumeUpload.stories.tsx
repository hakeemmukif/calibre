import type { Meta, StoryObj } from "@storybook/react";
import { ResumeUpload } from "./ResumeUpload";
import { Card } from "../../components/Card";
import { Icon } from "../../components/Icon";

const meta: Meta<typeof ResumeUpload> = {
  title: "Compositions/Resume/ResumeUpload",
  component: ResumeUpload,
  parameters: { layout: "padded" },
};
export default meta;
type Story = StoryObj<typeof ResumeUpload>;

const noop = () => console.log("onFile");

export const Idle: Story = {
  args: { status: "idle", onFile: noop },
  decorators: [(Story) => <div style={{ maxWidth: 440 }}><Story /></div>],
};

// DragOver — a purely visual snapshot of the drag-over highlight (real drag
// events only fire in a live browser, not Storybook Docs); the component
// itself drives this from native onDragEnter/onDrop, no extra prop invented.
export const DragOver: Story = {
  render: () => (
    <div style={{ maxWidth: 440 }}>
      <Card
        padding="lg"
        radius="lg"
        style={{ border: "1.5px dashed var(--accent)", background: "var(--accent-soft)", textAlign: "center" }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "18px 8px" }}>
          <Icon name="upload" size={28} style={{ color: "var(--accent)" }} />
          <div style={{ font: "var(--type-h3)", color: "var(--text-strong)" }}>Drop your résumé here</div>
          <div style={{ font: "var(--type-caption)", color: "var(--text-muted)" }}>PDF or DOCX, up to 10 MB</div>
        </div>
      </Card>
    </div>
  ),
};

export const Uploading: Story = {
  args: { status: "uploading", progress: 40, onFile: noop },
  decorators: [(Story) => <div style={{ maxWidth: 440 }}><Story /></div>],
};

export const Parsing: Story = {
  args: { status: "parsing", progress: 80, onFile: noop },
  decorators: [(Story) => <div style={{ maxWidth: 440 }}><Story /></div>],
};

export const ParseError: Story = {
  args: { status: "error", error: "That file looks corrupted — try re-exporting it as a PDF.", onFile: noop },
  decorators: [(Story) => <div style={{ maxWidth: 440 }}><Story /></div>],
};

export const Done: Story = {
  args: { status: "done", onFile: noop },
  decorators: [(Story) => <div style={{ maxWidth: 440 }}><Story /></div>],
};
