import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import ConnectionStatus from "./ConnectionStatus";

describe("ConnectionStatus", () => {
  it("shows a connected message when status is connected", () => {
    render(<ConnectionStatus status="connected" />);

    expect(screen.getByText("接続 OK")).toBeInTheDocument();
  });

  it("shows a disconnected message when status is disconnected", () => {
    render(<ConnectionStatus status="disconnected" />);

    expect(screen.getByText("サーバー未接続")).toBeInTheDocument();
  });

  it("shows a checking message when status is checking", () => {
    render(<ConnectionStatus status="checking" />);

    expect(screen.getByText("確認中...")).toBeInTheDocument();
  });
});
