import React, { useState } from "react";
import JoinPage from "./pages/JoinPage";
import MeetingRoom from "./pages/MeetingRoom";

function App() {
  const [roomData, setRoomData] = useState(null);

  const handleJoin = (roomId, name) => {
    setRoomData({ roomId, name });
  };

  if (!roomData) {
    return <JoinPage onJoin={handleJoin} />;
  }

  return (
    <MeetingRoom
      roomId={roomData.roomId}
      name={roomData.name}
    />
  );
}

export default App;