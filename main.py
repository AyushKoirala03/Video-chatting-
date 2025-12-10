import asyncio
import json
import uuid
from datetime import datetime
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from typing import Dict, List

app = FastAPI(title="Video Chat App")

# Serve static files
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")

# Connection management
class ConnectionManager:
    def __init__(self):
        # Store active connections: {room_id: {client_id: websocket}}
        self.active_rooms: Dict[str, Dict[str, WebSocket]] = {}
        # Store client info: {client_id: {"room": room_id, "name": username}}
        self.client_info: Dict[str, Dict] = {}
    
    async def connect(self, websocket: WebSocket, client_id: str, room_id: str, username: str):
        await websocket.accept()
        
        # Initialize room if not exists
        if room_id not in self.active_rooms:
            self.active_rooms[room_id] = {}
        
        # Store connection
        self.active_rooms[room_id][client_id] = websocket
        self.client_info[client_id] = {
            "room": room_id,
            "name": username,
            "joined_at": datetime.now().isoformat()
        }
        
        # Notify others in room
        await self.broadcast_to_room(room_id, {
            "type": "user_joined",
            "client_id": client_id,
            "username": username,
            "timestamp": datetime.now().isoformat()
        }, exclude_client_id=client_id)
        
        # Send room info to new user
        room_clients = list(self.active_rooms[room_id].keys())
        existing_users = [
            {
                "client_id": cid,
                "username": self.client_info[cid]["name"]
            }
            for cid in room_clients if cid != client_id
        ]
        
        await websocket.send_json({
            "type": "room_joined",
            "room_id": room_id,
            "client_id": client_id,
            "existing_users": existing_users,
            "timestamp": datetime.now().isoformat()
        })
    
    async def disconnect(self, client_id: str):
        if client_id in self.client_info:
            room_id = self.client_info[client_id]["room"]
            
            # Remove from room
            if room_id in self.active_rooms and client_id in self.active_rooms[room_id]:
                del self.active_rooms[room_id][client_id]
                
                # Notify others
                await self.broadcast_to_room(room_id, {
                    "type": "user_left",
                    "client_id": client_id,
                    "username": self.client_info[client_id]["name"],
                    "timestamp": datetime.now().isoformat()
                })
                
                # Clean up empty room
                if not self.active_rooms[room_id]:
                    del self.active_rooms[room_id]
            
            # Remove client info
            del self.client_info[client_id]
    
    async def send_to_client(self, client_id: str, message: dict):
        if client_id in self.client_info:
            room_id = self.client_info[client_id]["room"]
            if room_id in self.active_rooms and client_id in self.active_rooms[room_id]:
                websocket = self.active_rooms[room_id][client_id]
                await websocket.send_json(message)
    
    async def broadcast_to_room(self, room_id: str, message: dict, exclude_client_id: str = None):
        if room_id in self.active_rooms:
            for client_id, websocket in self.active_rooms[room_id].items():
                if client_id != exclude_client_id:
                    await websocket.send_json(message)
    
    async def relay_message(self, from_client_id: str, to_client_id: str, message: dict):
        """Relay a message from one client to another"""
        if (to_client_id in self.client_info and 
            from_client_id in self.client_info):
            
            # Verify they're in the same room
            if (self.client_info[from_client_id]["room"] == 
                self.client_info[to_client_id]["room"]):
                
                await self.send_to_client(to_client_id, {
                    **message,
                    "from": from_client_id
                })

manager = ConnectionManager()

@app.get("/")
async def get_root(request: Request):
    """Serve the main page"""
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/health")
async def health_check():
    """Health check endpoint"""
    return {"status": "ok", "timestamp": datetime.now().isoformat()}

@app.websocket("/ws/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    """WebSocket endpoint for signaling"""
    try:
        # First message should be join information
        data = await websocket.receive_json()
        
        if data["type"] == "join":
            room_id = data.get("room_id", "default")
            username = data.get("username", f"User_{client_id[:6]}")
            
            # Connect to room
            await manager.connect(websocket, client_id, room_id, username)
            
            # Handle subsequent messages
            while True:
                data = await websocket.receive_json()
                message_type = data.get("type")
                
                if message_type == "signal":
                    # Relay WebRTC signaling messages
                    to_client_id = data.get("to")
                    if to_client_id:
                        await manager.relay_message(client_id, to_client_id, {
                            "type": "signal",
                            "signal": data.get("signal"),
                            "signal_type": data.get("signal_type")  # offer, answer, candidate
                        })
                
                elif message_type == "chat":
                    # Broadcast chat messages
                    room_id = manager.client_info[client_id]["room"]
                    await manager.broadcast_to_room(room_id, {
                        "type": "chat",
                        "from": client_id,
                        "username": manager.client_info[client_id]["name"],
                        "message": data.get("message"),
                        "timestamp": datetime.now().isoformat()
                    })
                
                elif message_type == "ping":
                    # Respond to ping
                    await websocket.send_json({
                        "type": "pong",
                        "timestamp": datetime.now().isoformat()
                    })
    
    except WebSocketDisconnect:
        await manager.disconnect(client_id)
    except Exception as e:
        print(f"WebSocket error: {e}")
        await manager.disconnect(client_id)

@app.get("/api/rooms")
async def list_rooms():
    """List all active rooms (for monitoring)"""
    rooms_info = {}
    for room_id, clients in manager.active_rooms.items():
        rooms_info[room_id] = {
            "user_count": len(clients),
            "users": [
                {
                    "client_id": cid,
                    "username": manager.client_info[cid]["name"]
                }
                for cid in clients.keys()
            ]
        }
    return rooms_info

if __name__ == "__main__":
    import uvicorn
    print("Starting Video Chat Server...")
    print("Open http://localhost:8000 in your browser")
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=True)