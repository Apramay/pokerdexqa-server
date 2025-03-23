const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");

const app = express();
app.use(cors());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Card and game constants
const suits = ["Hearts", "Diamonds", "Clubs", "Spades"];
const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const rankValues = {
    "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14
};

// Game state variables
let players = [];
let tableCards = [];
let pot = 0;
let currentPlayerIndex = 0;
let deckForGame = [];
let currentBet = 0;
let dealerIndex = 0;
let round = 0;
let smallBlindAmount = 10;
let bigBlindAmount = 20;
let playersWhoActed = new Set();

// Function to create a new deck of cards
function createDeck() {
    let deck = [];
    suits.forEach(suit => {
        ranks.forEach(rank => {
            deck.push({ suit, rank });
        });
    });
    return deck.sort(() => Math.random() - 0.5);
}

// Function to broadcast data to all connected clients
function broadcast(data) {
    const jsonData = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(jsonData);
        }
    });
}

// Function to broadcast the current game state to all clients
function broadcastGameState() {
    players.forEach(player => {
        const privateGameState = {
            type: "updateGameState",
            players: players.map(({ ws, hand, ...playerData }) => ({
                ...playerData, 
                hand: player.name === playerData.name ? hand : Array(hand.length).fill({ rank: "back", suit: "back" })
            })),
            tableCards,
            pot,
            currentBet,
            round,
            currentPlayerIndex,
            dealerIndex
        };

        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(privateGameState));
        }
    });
}


// Function to start the game
function startGame() {
    if (players.length < 2) {
        console.log("❌ Not enough players to start the game.");
        return;
    }
    deckForGame = shuffleDeck(createDeck());
    dealerIndex = Math.floor(Math.random() * players.length);
    startNewHand();
    broadcast({ type: "startGame" });
    broadcastGameState();
}

// Function to start a new hand
function startNewHand() {
    // Reset game state for a new hand
    tableCards = [];
    pot = 0;
    currentBet = 0;
    playersWhoActed.clear();
    deckForGame = shuffleDeck(createDeck());
    round = 0; // Reset to preflop

    // Move the dealer button
    dealerIndex = (dealerIndex + 1) % players.length;

    // Determine small blind and big blind indices
    let smallBlindIndex = (dealerIndex + 1) % players.length;
    let bigBlindIndex = (dealerIndex + 2) % players.length;


    // Reset player states and deal cards
    players.forEach((player, index) => {
        player.hand = dealHand(deckForGame, 2);
        player.currentBet = 0;
        player.status = "active"; // Reset player status
        player.isSmallBlind = index === smallBlindIndex;
        player.isBigBlind = index === bigBlindIndex;
        player.tokens -= player.isSmallBlind ? smallBlindAmount : player.isBigBlind ? bigBlindAmount : 0;
        pot += player.isSmallBlind ? smallBlindAmount : player.isBigBlind ? bigBlindAmount : 0;
        player.currentBet = player.isSmallBlind ? smallBlindAmount : player.isBigBlind ? bigBlindAmount : 0;
    });
    currentBet = bigBlindAmount;


    // Set the starting player (after the big blind)
    currentPlayerIndex = (bigBlindIndex + 1) % players.length;

    // Broadcast the updated game state
    broadcastGameState();
}

function setupBlinds() {
    pot = 0;
    const smallBlindIndex = (dealerIndex + 1) % players.length;
    const bigBlindIndex = (dealerIndex + 2) % players.length;

    console.log(`🎲 Setting up blinds: SB -> ${players[smallBlindIndex].name}, BB -> ${players[bigBlindIndex].name}`);

    postBlind(players[smallBlindIndex], smallBlindAmount);         // ✅ Small Blind posts
    postBlind(players[bigBlindIndex], bigBlindAmount, true);      // ✅ Big Blind posts & updates `currentBet`

    currentPlayerIndex = (bigBlindIndex + 1) % players.length; // ✅ First action goes to UTG (next after BB)

    playersWhoActed.clear();

    console.log(`🎯 First action: ${players[currentPlayerIndex].name}`);

    broadcastGameState();  // ✅ Ensures frontend gets the correct initial state

    broadcast({ 
        type: "blindsPosted", 
        smallBlind: players[smallBlindIndex].name, 
        bigBlind: players[bigBlindIndex].name 
    });

    setTimeout(bettingRound, 500); // ✅ Start the first betting round
}

function formatHand(hand) {
    return hand.map(card => `${card.rank} of ${card.suit}`).join(", ");
}


function postBlind(player, amount, isBigBlind = false) {
    const blindAmount = Math.min(amount, player.tokens);
    player.tokens -= blindAmount;
    player.currentBet = blindAmount;
    pot += blindAmount;

    if (player.tokens === 0) {
        player.allIn = true;
    }

    if (isBigBlind) {  // ✅ Added: Ensure `currentBet` is set to the BB amount
        currentBet = blindAmount;
    }

    console.log(`💰 ${player.name} posts ${blindAmount}. Pot: ${pot}, Current Bet: ${currentBet}`);
}



function getNextPlayerIndex(currentIndex) {
    console.log(`🔄 Finding next player from index ${currentIndex}`);

    let nextIndex = (currentIndex + 1) % players.length;
    let attempts = 0;

    while (attempts < players.length) {
        let nextPlayer = players[nextIndex];

        if (nextPlayer.status === "active" && nextPlayer.tokens > 0 && !nextPlayer.allIn) {
            console.log(`🎯 Next player is ${nextPlayer.name}`);
            return nextIndex;
        }

        console.log(`⏩ Skipping ${nextPlayer.name} (Status: ${nextPlayer.status}, Tokens: ${nextPlayer.tokens})`);
        nextIndex = (nextIndex + 1) % players.length;
        attempts++;
    }

    console.log("✅ All players have acted. Moving to the next round.");
    setTimeout(nextRound, 1000);
    return -1;
}


function bettingRound() {
    console.log("Starting betting round...");
    let activePlayers = players.filter(p => p.status === "active" && !p.allIn && p.tokens > 0);
    if (activePlayers.length <= 1 ) {
        console.log("Betting round over, moving to next round.");
        setTimeout(nextRound, 1000);
        return;
    }
    if (isBettingRoundOver()) {
        console.log("All players have acted. Betting round is over.");
        setTimeout(nextRound, 1000);
        return;
    }
    const player = players[currentPlayerIndex];
    if (playersWhoActed.has(player.name) && player.currentBet === currentBet) {
        console.log(`${player.name} has already acted. Skipping...`);
        currentPlayerIndex = getNextPlayerIndex(currentPlayerIndex);
        bettingRound();
        return;
    }
    console.log(`Waiting for player ${player.name} to act...`);
    broadcast({ type: "playerTurn", playerName: player.name });
}

function isBettingRoundOver() {
    console.log("📊 Checking if betting round is over...");
    console.log("playersWhoActed:", [...playersWhoActed]);
    console.log("Current Bet:", currentBet);
    console.log("Active Players:", players.filter(p => p.status === "active").map(p => p.name));

    let activePlayers = players.filter(p => p.status === "active" && !p.allIn && p.tokens > 0);
    
    if (activePlayers.length <= 1) return true; // ✅ Only one player left, round ends immediately

    // ✅ Ensure all active players have either checked or matched the current bet
    const allCalledOrChecked = activePlayers.every(player => 
        playersWhoActed.has(player.name) &&
        (player.currentBet === currentBet || currentBet === 0)
    );

    console.log("✅ Betting round over:", allCalledOrChecked);
    return allCalledOrChecked;
}



function bigBlindCheckRaiseOption() {
    let bigBlindPlayer = players[(dealerIndex + 2) % players.length];

    if (currentBet === bigBlindAmount) { 
       console.log(`${bigBlindPlayer.name}, you can check or bet.`);
        bigBlindPlayer.ws.send(JSON.stringify({
            type: "bigBlindAction",
            options: ["check", "raise"]
        }));
    } else  {
        console.log(`${bigBlindPlayer.name}, you must call or fold.`);
        bigBlindPlayer.ws.send(JSON.stringify({
            type: "bigBlindAction",
            message: `${bigBlindPlayer.name}, you must call or fold.`,
            options: ["call", "fold", "raise"]
        }));
    }
}

// Function to deal a hand of cards to a player
function dealHand(deck, numCards) {
    const hand = [];
    for (let i = 0; i < numCards; i++) {
        hand.push(deck.pop());
    }
    return hand;
}

// Function to shuffle the deck of cards
function shuffleDeck(deck) {
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function startFlopBetting() {
    currentBet = 0;
    playersWhoActed.clear();

    // ✅ Get the first active player left of the dealer
    currentPlayerIndex = getNextPlayerIndex(dealerIndex);
    console.log(`🎯 Starting post-flop betting with: ${players[currentPlayerIndex].name}`);
    playersWhoActed.clear();

    // ✅ Broadcast correct first player
    broadcast({
        type: "playerTurn",
        playerName: players[currentPlayerIndex].name
    });

    bettingRound();
}


function nextRound() {
    console.log("nextRound() called. Current round:", round);

    currentBet = 0;
    players.forEach(player => (player.currentBet = 0));
    playersWhoActed.clear();
        console.log("🆕 New round started. Reset playersWhoActed."); // ✅ Debugging log


    if (round === 0) {
        round ++;
        tableCards = dealHand(deckForGame, 3); // Flop
        broadcast({ type: "message", text: `Flop: ${JSON.stringify(tableCards)}` });
    } else if (round === 1) {
        round ++;
        if (deckForGame.length > 0) {
                    tableCards.push(dealHand(deckForGame, 1)[0]); // Turn
        broadcast({ type: "message", text: `Turn: ${JSON.stringify(tableCards[3])}` });
        }
    } else if (round === 2) {
        round++;
        if (deckForGame.length > 0) {
                    tableCards.push(dealHand(deckForGame, 1)[0]); // Turn
        broadcast({ type: "message", text: `River: ${JSON.stringify(tableCards[4])}` });
        }
    } else if (round === 3) {
        showdown();
        return;
    }

    broadcastGameState();
    setTimeout(() => startFlopBetting(), 1500);
}

function showdown() {
    console.log("🏆 Showdown!");
    let activePlayers = players.filter(p => p.status === "active" || p.allIn);
    let winners = determineWinners(activePlayers);

    winners.forEach(winner => {
        console.log(`🎉 ${winner.name} wins the hand!`);
    });

    // ✅ Automatically reveal the winner's hand
    let revealedHands = winners.map(winner => {
        const fullHand = winner.hand.concat(tableCards);
        const { bestCards } = evaluateHand(fullHand); // Extract the best 5-card hand

        return {
            playerName: winner.name,
            hand: bestCards  // ✅ Showing only the best 5 cards
        };
    });

    // ✅ Broadcast revealed winner hands to all players
    broadcast({
        type: "showdown",
        winners: revealedHands,
    });

    // ✅ Record winning hand in history
    broadcast({
        type: "updateActionHistory",
        action: `🏆 Winner: ${winners.map(w => w.name).join(", ")} - Hand: ${formatHand(revealedHands[0].hand)}`
    });

    distributePot();

    // ✅ Give players the option to "Show" or "Hide" their hands
 let remainingPlayers = activePlayers.filter(p => !winners.includes(p)).map(p => p.name);

    if (remainingPlayers.length > 0) {
        broadcast({
            type: "showOrHideCards",
            remainingPlayers
        });

        // ✅ Auto-start next hand if no action in 10 seconds
        setTimeout(() => {
            if (remainingPlayers.length > 0) {
                console.log("⏳ No player responded. Automatically starting the next hand...");
                resetGame();
            }
        }, 10000); // 10 seconds
    } else {
        setTimeout(resetGame, 5000);
    }
}

function distributePot() {
    let activePlayers = players.filter(p => p.status === "active" || p.allIn);
    activePlayers.sort((a, b) => a.currentBet - b.currentBet);

    let totalPot = pot;
    let sidePots = [];
    while (activePlayers.length > 0) {
        const minBet = activePlayers[0].currentBet;
        let potPortion = 0;

        activePlayers.forEach(player => {
            potPortion += Math.min(minBet, player.currentBet);
            player.currentBet -= Math.min(minBet, player.currentBet);
        });

        sidePots.push({ players: [...activePlayers], amount: potPortion });
        activePlayers = activePlayers.filter(p => p.currentBet > 0);
    }

    sidePots.forEach(sidePot => {
        let winners = determineWinners(sidePot.players);
        let splitPot = Math.floor(sidePot.amount / winners.length);
        winners.forEach(winner => {
            winner.tokens += splitPot;
        });
    });
let remainingPot = totalPot - sidePots.reduce((acc, sp) => acc + sp.amount, 0);
    if (remainingPot > 0) {
        let mainWinners = determineWinners(players.filter(p => p.status === "active"));
        let splitPot = Math.floor(remainingPot / mainWinners.length);
        mainWinners.forEach(winner => {
            winner.tokens += splitPot;
            console.log(`${winner.name} wins ${splitPot} from the main pot.`);
        });
    }
}
function resetGame() {
    console.log("Resetting game for the next round.");
    round = 0;
    tableCards = [];
    pot = 0;

    // ✅ Move the dealer button to the next active player
    dealerIndex = (dealerIndex + 1) % players.length;

    // ✅ Reset all players for a new round
    players.forEach(player => {
        player.hand = [];
        player.currentBet = 0;
        player.status = "active";
        player.allIn = false;
    });

    console.log(`🎲 New dealer is: ${players[dealerIndex].name}`);

    startNewHand(); // ✅ Start the new round with correct dealer
}

function determineWinners(playerList) {
    if (playerList.length === 0) {
        return [];
    }

    let bestHandValue = -1;
    let winners = [];
    let bestHandDetails = null; // To store best hand details for tiebreakers

    playerList.forEach(player => {
        if (player.status !== "folded") {
            const fullHand = player.hand.concat(tableCards);
            const { handValue, bestCards } = evaluateHand(fullHand);

            if (handValue > bestHandValue) {
                bestHandValue = handValue;
                winners = [player];
                bestHandDetails = bestCards;
            } else if (handValue === bestHandValue) {
                // ✅ Handle tie cases by comparing kicker
                if (compareHands(bestCards, bestHandDetails) > 0) {
                    winners = [player]; // New best kicker
                    bestHandDetails = bestCards;
                } else if (compareHands(bestCards, bestHandDetails) === 0) {
                    winners.push(player); // Exact tie, add both winners
                }
            }
        }
    });

    return winners;
}


// Function to evaluate the hand of a player
function evaluateHand(cards) {
    const sortedHand = cards.slice().sort((a, b) => rankValues[b.rank] - rankValues[a.rank]);
    const ranks = sortedHand.map(card => card.rank);
    const suits = sortedHand.map(card => card.suit);

    if (isRoyalFlush(sortedHand, ranks, suits)) return { handValue: 10, bestCards: sortedHand };
    if (isStraightFlush(sortedHand, ranks, suits)) return { handValue: 9, bestCards: sortedHand };
    if (isFourOfAKind(sortedHand, ranks)) return { handValue: 8, bestCards: sortedHand };
    if (isFullHouse(sortedHand, ranks)) return { handValue: 7, bestCards: sortedHand };
    if (isFlush(sortedHand, suits)) return { handValue: 6, bestCards: sortedHand };
    if (isStraight(sortedHand, ranks)) return { handValue: 5, bestCards: sortedHand };
    if (isThreeOfAKind(sortedHand, ranks)) return { handValue: 4, bestCards: sortedHand };
    if (isTwoPair(sortedHand, ranks)) return { handValue: 3, bestCards: sortedHand };
    if (isOnePair(sortedHand, ranks)) return { handValue: 2, bestCards: sortedHand };

    return { handValue: 1, bestCards: sortedHand.slice(0, 5) }; // High card
}


// Helper functions to check for different hand types
function isRoyalFlush(hand, ranks, suits) {
    if (!isFlush(hand, suits)) return false;
    const royalRanks = ["10", "J", "Q", "K", "A"];
    return royalRanks.every(rank => ranks.includes(rank));
}

function isStraightFlush(hand, ranks, suits) {
    return isFlush(hand, suits) && isStraight(hand, ranks);
}

function isFourOfAKind(hand, ranks) {
    for (let rank of ranks) {
        if (ranks.filter(r => r === rank).length === 4) {
            return true;
        }
    }
    return false;
}

function isFullHouse(hand, ranks) {
    let three = false;
    let pair = false;
    for (let rank of ranks) {
        if (ranks.filter(r => r === rank).length === 3) {
            three = true;
        }
        if (ranks.filter(r => r === rank).length === 2) {
            pair = true;
        }
    }
    return three && pair;
}

function isFlush(hand, suits) {
    return suits.every(suit => suit === suits[0]);
}

function isStraight(hand, ranks) {
    const handValues = hand.map(card => rankValues[card.rank]) // ✅ Renamed to avoid conflict
        .sort((a, b) => a - b);

    // Normal straight check
    for (let i = 0; i <= handValues.length - 5; i++) {
        if (handValues[i + 4] - handValues[i] === 4 &&
            new Set(handValues.slice(i, i + 5)).size === 5) {
            return true;
        }
    }

    // Special case: A, 2, 3, 4, 5 (Low Straight)
    if (handValues.includes(14) && handValues.slice(0, 4).join() === "2,3,4,5") {
        return true;
    }

    return false;
}


function isThreeOfAKind(hand, ranks) {
    for (let rank of ranks) {
        if (ranks.filter(r => r === rank).length === 3) {
            return true;
        }
    }
    return false;
}

function isTwoPair(hand, ranks) {
    let pairs = 0;
    let checkedRanks = new Set();
    for (let rank of ranks) {
        if (checkedRanks.has(rank)) continue;
        if (ranks.filter(r => r === rank).length === 2) {
            pairs++;
            checkedRanks.add(rank);
        }
    }
    return pairs === 2;
}

function isOnePair(hand, ranks) {
    for (let rank of ranks) {
        if (ranks.filter(r => r === rank).length === 2) {
            return true;
        }
    }
    return false;
}
function compareHands(handA, handB) {
    for (let i = 0; i < Math.min(handA.length, handB.length); i++) {
        if (rankValues[handA[i].rank] > rankValues[handB[i].rank]) return 1;
        if (rankValues[handA[i].rank] < rankValues[handB[i].rank]) return -1;
    }
    return 0; // Exact tie
}

// WebSocket server event handling
wss.on('connection', function connection(ws) {
    console.log('✅ A new client connected');

    ws.on('message', function incoming(message) {
        console.log('📩 Received message from client:', message);

        try {
            const data = JSON.parse(message);

            // ✅ Handle "Show or Hide" Decision
            if (data.type === "showHideDecision") {
            let player = players.find(p => p.name === data.playerName);
            if (!player) return;

            if (data.choice === "show") {
                console.log(`👀 ${player.name} chose to SHOW their hand!`);
                broadcast({
                    type: "updateActionHistory",
                    action: `👀 ${player.name} revealed: ${formatHand(player.hand)}`
                });
            } else {
                console.log(`🙈 ${player.name} chose to HIDE their hand.`);
                broadcast({
                    type: "updateActionHistory",
                    action: `🙈 ${player.name} chose to keep their hand hidden.`
                });
            }

            // ✅ Remove player from the waiting list
            playersWhoNeedToDecide = playersWhoNeedToDecide.filter(p => p !== data.playerName);

            // ✅ If all players have chosen, start the next round
            if (playersWhoNeedToDecide.length === 0) {
                setTimeout(resetGame, 3000);
            }
        }

            // ✅ Handle other game actions separately
            if (data.type === 'join') {
                const player = {
                    name: data.name,
                    ws: ws,
                    tokens: 1000,
                    hand: [],
                    currentBet: 0,
                    status: 'active',
                    allIn: false
                };
                players.push(player);
                console.log(`➕ Player ${data.name} joined. Total players: ${players.length}`);
                broadcast({ type: 'updatePlayers', players: players.map(({ ws, ...player }) => player) });

            } else if (data.type === 'startGame') {
                startGame();
            } else if (data.type === 'bet') {
                handleBet(data);
            } else if (data.type === 'raise') {
                handleRaise(data);
            } else if (data.type === 'call') {
                handleCall(data);
            } else if (data.type === 'fold') {
                handleFold(data);
            } else if (data.type === 'check') {
                handleCheck(data);
            }

        } catch (error) {
            console.error('❌ Error parsing message:', error);
        }
    });

    ws.on('close', () => {
        console.log('❌ Client disconnected');
        players = players.filter(player => player.ws !== ws);
        broadcast({ type: 'updatePlayers', players: players.map(({ ws, ...player }) => player) });
    });
});


// Action handlers
function handleRaise(data) {
    console.log(`🔄 ${data.playerName} performed action: ${data.type}`);
console.log("Before updating playersWhoActed:", [...playersWhoActed]);

    const player = players.find(p => p.name === data.playerName);
    if (!player) {
        console.error("Player not found:", data.playerName);
        return;
    }

    const raiseAmount = parseInt(data.amount);

    if (raiseAmount <= currentBet || raiseAmount > player.tokens) {
        console.error("Invalid raise amount:", data.playerName);
        return;
    }

    const totalBet = raiseAmount;
    player.tokens -= totalBet - player.currentBet;
    pot += totalBet - player.currentBet;
    player.currentBet = totalBet;
    currentBet = totalBet;

    // ✅ Mark this player as having acted
    playersWhoActed.add(player.name);
    console.log("After updating playersWhoActed:", [...playersWhoActed]);


    // Move to the next player
    currentPlayerIndex = getNextPlayerIndex(currentPlayerIndex);
broadcast({
        type: "updateActionHistory",
        action: `${data.playerName} raised ${raiseAmount}`
    });
    // Broadcast the updated game state
    broadcastGameState();
}

function handleCall(data) {
    console.log(`🔄 ${data.playerName} performed action: ${data.type}`);
    console.log("Before updating playersWhoActed:", [...playersWhoActed]);

    const player = players.find(p => p.name === data.playerName);
    if (!player) {
        console.error("Player not found:", data.playerName);
        return;
    }

    let amount = Math.min(currentBet - player.currentBet, player.tokens);
    player.tokens -= amount;
    player.currentBet += amount;
    pot += amount;
    if (player.tokens === 0) {
        player.allIn = true;
    }

    // ✅ Add player to "acted" set
    playersWhoActed.add(player.name);
    console.log("After updating playersWhoActed:", [...playersWhoActed]);
    broadcast({
        type: "updateActionHistory",
        action: `${data.playerName} called`
    });

    // ✅ Check if ALL players have acted before moving forward
    if (isBettingRoundOver()) {
        console.log("✅ All players have called/checked. Moving to next round.");
        setTimeout(nextRound, 1000);
    } else {
        // ✅ Instead of skipping players, ensure next active player gets a turn
        const nextIndex = getNextPlayerIndex(currentPlayerIndex);
        if (nextIndex !== -1) {
            currentPlayerIndex = nextIndex;
            console.log(`🎯 Next player is ${players[currentPlayerIndex].name}`);
            broadcastGameState();
        } else {
            console.log("⚠️ No valid next player found. Ending round.");
            setTimeout(nextRound, 1000);
        }
    }
}
function handleFold(data) {
    console.log(`🔄 ${data.playerName} performed action: ${data.type}`);
    console.log("Before updating playersWhoActed:", [...playersWhoActed]);

    const player = players.find(p => p.name === data.playerName);
    if (!player) {
        console.error("Player not found:", data.playerName);
        return;
    }

    player.status = "folded";

    // ✅ Mark this player as having acted
    playersWhoActed.add(player.name);
    console.log("After updating playersWhoActed:", [...playersWhoActed]);
     broadcast({
        type: "updateActionHistory",
        action: `${data.playerName} folded`
    });

    // ✅ Move to the next player only once
    const nextIndex = getNextPlayerIndex(currentPlayerIndex);
    if (nextIndex !== -1) {
        currentPlayerIndex = nextIndex;
    }

    if (isBettingRoundOver()) {
        console.log("✅ All players have acted. Moving to next round.");
        setTimeout(nextRound, 1000);
    } else {
        broadcastGameState();  // ✅ Only update the UI once
    }
}


function handleCheck(data) {
    console.log(`🔄 ${data.playerName} performed action: ${data.type}`);
    console.log("Before updating playersWhoActed:", [...playersWhoActed]);

    const player = players.find(p => p.name === data.playerName);
    if (!player) {
        console.error("❌ Player not found:", data.playerName);
        return; // ✅ Prevents processing an invalid action
    }

    if (currentBet === 0 || player.currentBet === currentBet) {
        console.log(`${player.name} checked.`);
        playersWhoActed.add(player.name);
        console.log("After updating playersWhoActed:", [...playersWhoActed]);
         broadcast({
            type: "updateActionHistory",
            action: `${data.playerName} checked`
        });


        if (isBettingRoundOver()) {
            setTimeout(nextRound, 1000);
        } else {
            setTimeout(() => {
                currentPlayerIndex = getNextPlayerIndex(currentPlayerIndex);
                broadcastGameState();
            }, 500);
        }
    }
}


// Start the server
server.listen(process.env.PORT || 8080, () => {
    console.log(`WebSocket server started on port ${server.address().port}`);
});
