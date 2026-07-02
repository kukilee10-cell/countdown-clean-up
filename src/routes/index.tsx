import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Journey Home — Work today. Home tomorrow." },
      { name: "description", content: "Journey Home — the premium countdown app for FIFO workers. Work today. Home tomorrow." },
      { property: "og:title", content: "Journey Home" },
      { property: "og:description", content: "Work today. Home tomorrow. The premium countdown for FIFO workers." },
    ],
  }),
  component: Index,
});

function Index() {
  // The Journey Home app is a static site under /public/fifo/.
  // Redirect the Lovable root URL to it so the published site shows the real app.
  if (typeof window !== "undefined") {
    window.location.replace("/fifo/index.html");
  }
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0d0f12",
        color: "#f5a623",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      Loading Journey Home…
    </div>
  );
}
