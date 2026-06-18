# Dirty Espionage

A multiplayer word game where 3 players try to identify the imposter among them.

## How to Play

1. **Create or Join a Room**: One player creates a room, others join with the room code
2. **Get Your Word**: Each player receives a secret word (some get "normal", one gets "dirty")
3. **Write Sentences**: Take turns writing sentences using your word without revealing it
4. **Vote**: After 5 rounds, vote for who you think has the unique word
5. **Win**: Agents win if they correctly identify the imposter. Imposter wins if they fool the agents.

## Setup Instructions (Windows)

### Prerequisites
- Python 3.8 or higher installed on your computer

### First Time Setup

1. **Open a terminal/command prompt** in the "My Game" folder

2. **Navigate to the backend folder**:
   ```bash
   cd backend
   ```

3. **Activate the virtual environment**:
   ```bash
   .venv\Scripts\activate
   ```

4. **Install the required packages**:
   ```bash
   pip install -r requirements.txt
   ```

### Running the Game

**Option 1: Using the startup script (Recommended)**
- Double-click `start_game.bat` in the "My Game" folder
- The server will start automatically
- Open your browser to: http://localhost:8000

**Option 2: Manual startup**
1. Open a terminal in the "My Game" folder
2. Navigate to the backend folder:
   ```bash
   cd backend
   ```
3. Activate the virtual environment:
   ```bash
   .venv\Scripts\activate
   ```
4. Start the server:
   ```bash
   python main.py
   ```
5. Open your browser to: http://localhost:8000

## Playing with Friends

### Playing on Same WiFi Network (Local)

1. **Find your computer's IP address**:
   - Open Command Prompt and type: `ipconfig`
   - Look for "IPv4 Address" (usually something like 192.168.1.X)

2. **Start the server** as described above

3. **Share the URL** with your friends:
   - Replace `localhost` with your IP address
   - Example: `http://192.168.1.5:8000`

4. **Note**: All players must be on the same WiFi network for this to work

### Playing on Different Computers (Online)

To play with friends anywhere in the world, you need to host the game online. See the "Web Hosting" section below for instructions on deploying to a cloud service like Render.com or Railway.app.

## Web Hosting

To make your game playable from anywhere (not just same WiFi), you need to deploy it to a cloud service.

### Render.com (Recommended - Free)

1. **Create a GitHub account** and push your game code to a repository
2. **Sign up at render.com**
3. **Create a new Web Service**
4. **Connect your GitHub repository**
5. **Set the build command**: `pip install -r requirements.txt`
6. **Set the start command**: `uvicorn main:app --host 0.0.0.0 --port $PORT`
7. **Deploy** - Render will give you a URL like `https://your-game.onrender.com`

### Railway.app (Also Free)

Similar to Render:
1. Sign up at railway.app
2. Create a new project
3. Deploy from your GitHub repository
4. Set environment variables if needed
5. Get your public URL

## Troubleshooting

**"Module not found" errors**: Make sure you activated the virtual environment and installed requirements.txt

**"Address already in use"**: Something else is using port 8000. You can change the port by editing the startup command to use a different port (e.g., `uvicorn main:app --port 8001`)

**Can't connect from another device**: 
- Make sure you're on the same WiFi network
- Use your computer's IP address instead of localhost (e.g., http://192.168.1.5:8000)
- Check Windows Firewall settings to allow Python through
- Try disabling VPN if you have one

**Game won't start**:
- Make sure you're the host (first player in the room)
- Wait for all 3 players to join
- Click the "START MISSION" button (only visible to host)

**Players can't submit sentences**:
- Make sure it's actually your turn (check the turn banner)
- Wait for the turn to pass to you
- If stuck, refresh and rejoin the room

## Project Structure

```
My Game/
├── backend/
│   ├── main.py           # FastAPI server
│   ├── game.py           # Game logic
│   ├── requirements.txt  # Python dependencies
│   ├── word_pairs.json   # Word pairs for the game
│   └── .venv/           # Virtual environment
├── frontend/
│   ├── index.html       # Main HTML file
│   ├── styles.css       # Cyberpunk styling
│   ├── app.js           # Game logic and WebSocket handling
│   └── audio.js         # Sound effects
├── start_game.bat       # Startup script (Windows)
└── README.md           # This file
```

## Technologies Used

- **Backend**: Python, FastAPI, WebSockets
- **Frontend**: HTML, CSS, JavaScript (Vanilla)
- **Audio**: Web Audio API (no external files needed)
