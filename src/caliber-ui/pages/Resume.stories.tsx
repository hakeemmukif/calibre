import * as React from "react";
import type { Meta, StoryObj } from "@storybook/react";
import { ResumeUpload, type ResumeUploadStatus } from "../compositions/Resume/ResumeUpload";
import { ResumeView } from "../compositions/Resume/ResumeView";
import { resume } from "../fixtures";

const meta: Meta = {
  title: "Pages/Resume",
  parameters: { layout: "fullscreen" },
};
export default meta;
type Story = StoryObj;

// Pages/Resume — F1 assembled on fixtures: before a résumé exists the page
// is ResumeUpload; once parsed it hands off to ResumeView. Re-upload sends
// it back through the same upload lifecycle.
function ResumePage() {
  const [hasResume, setHasResume] = React.useState(true);
  const [status, setStatus] = React.useState<ResumeUploadStatus>("idle");

  function handleFile() {
    setStatus("uploading");
    window.setTimeout(() => setStatus("parsing"), 700);
    window.setTimeout(() => {
      setStatus("done");
      window.setTimeout(() => setHasResume(true), 500);
    }, 1500);
  }

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg-app)", padding: 24 }}>
      <div style={{ maxWidth: 760, margin: "0 auto" }}>
        {hasResume ? (
          <ResumeView
            resume={resume}
            onTailor={() => console.log("tailor")}
            onReupload={() => {
              setHasResume(false);
              setStatus("idle");
            }}
          />
        ) : (
          <ResumeUpload status={status} onFile={handleFile} />
        )}
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => <ResumePage />,
};
