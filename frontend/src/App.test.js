import { render, screen, fireEvent } from "@testing-library/react";
import App from "./App";

test("renders JoinPage and validates Room ID and Name before entering room", () => {
  render(<App />);

  expect(screen.getByText(/MeetSense AI/i)).toBeInTheDocument();

  const joinBtn = screen.getByRole("button", { name: /Join Meeting/i });
  fireEvent.click(joinBtn);
  expect(screen.getByText(/Please enter a Room ID/i)).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText(/Room ID/i), {
    target: { value: "standup-101" },
  });
  fireEvent.click(joinBtn);
  expect(screen.getByText(/Please enter your name/i)).toBeInTheDocument();

  fireEvent.change(screen.getByPlaceholderText(/Your Name/i), {
    target: { value: "Alice" },
  });
  fireEvent.click(joinBtn);

  expect(screen.getByText("standup-101")).toBeInTheDocument();
  expect(screen.getByText(/Engagement Analytics/i)).toBeInTheDocument();
  expect(screen.getByText(/Meeting Summary/i)).toBeInTheDocument();
});
