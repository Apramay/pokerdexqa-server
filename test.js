const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const app = express();
app.use(cors());
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store game state for each table
const tables = new Map();

// Card and game constants
const suits = ["Hearts", "Diamonds", "Clubs", "Spades"];
const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]; 
const rankValues = {
    "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14
}; 
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
function broadcast(data, tableId) {
    const jsonData = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.tableId === tableId && client.readyState === WebSocket.OPEN) {
            client.send(jsonData);
        }
    });
}
// Function to broadcast the current game state to all clients
function broadcastGameState(tableId) {
    const table = tables.get(tableId);
    if (!table) return;

    table.players.forEach(player => {
        const privateGameState = {
            type: "updateGameState",
            tableId: tableId, 
            players: table.players.map(({ ws, hand, ...playerData }) => ({
                ...playerData,
                hand: player.name === playerData.name ? hand
                    : Array(hand.length).fill({ rank: "back", suit: "back" })
            })),
            tableCards: table.tableCards,
            pot: table.pot,
            currentBet: table.currentBet,
            round: table.round,
            currentPlayerIndex: table.currentPlayerIndex,
            dealerIndex: table.dealerIndex
        };

        if (player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(JSON.stringify(privateGameState));
        }
    }); 
}
// Function to start the game
function startGame(tableId) {
    const table = tables.get(tableId);
    if (!table || table.players.length < 2) {
        console.log(" ❌  Not enough players to start the game.");
        return;
    }
    table.deckForGame = shuffleDeck(createDeck());
    table.dealerIndex = Math.floor(Math.random() * table.players.length);
    startNewHand(tableId);
    broadcast({ type: "startGame" }, tableId);
    broadcastGameState(tableId); 
}
// Function to start a new hand
function startNewHand(tableId) {
    const table = tables.get(tableId);
    if (!table) return;
    // Reset game state for a new hand
    table.tableCards = []; 
    table.pot = 0;
    table.currentBet = 0;
    table.playersWhoActed.clear();
    table.deckForGame = shuffleDeck(createDeck());
    table.round = 0;
    // Reset to preflop
    // Move the dealer button
    let activePlayers = table.players.filter(p => p.tokens > 0);
    if (activePlayers.length === 0) {
        console.log(" ⚠️ No active players left! Game cannot continue.");
        return;
    }
    table.dealerIndex = (table.dealerIndex + 1) % table.players.length;
    // Determine small blind and big blind indices
    let smallBlindIndex = (table.dealerIndex + 1) % table.players.length;
    let bigBlindIndex = (table.dealerIndex + 2) % table.players.length;
    // Reset player states and deal cards
    table.players.forEach((player, index) => {
        player.hand = player.tokens > 0 ? dealHand(table.deckForGame, 2) : [];
        player.currentBet = 0;
        player.status = player.tokens > 0 ? "active" : "inactive";
        player.isSmallBlind = (activePlayers[smallBlindIndex] && player.name === activePlayers[smallBlindIndex].name);
        player.isBigBlind = (activePlayers[bigBlindIndex] && player.name === activePlayers[bigBlindIndex].name);
        player.tokens -= player.isSmallBlind ? table.smallBlindAmount : player.isBigBlind ? table.bigBlindAmount : 0;

        table.pot += player.isSmallBlind ? table.smallBlindAmount : player.isBigBlind ? table.bigBlindAmount : 0;
        player.currentBet = player.isSmallBlind ? table.smallBlindAmount : player.isBigBlind ? table.bigBlindAmount : 0;
    });
    table.currentBet = table.bigBlindAmount;
    // Set the starting player (after the big blind)
    table.currentPlayerIndex = (bigBlindIndex + 1) % table.players.length;
    // Broadcast the updated game state
    broadcastGameState(tableId);
}

function setupBlinds(tableId) {
    const table = tables.get(tableId);
    if (!table) return;

    table.pot = 0; 
    const smallBlindIndex = (table.dealerIndex + 1) % table.players.length;
    const bigBlindIndex = (table.dealerIndex + 2) % table.players.length;
    console.log(` 🎲  Setting up blinds: SB -> ${table.players[smallBlindIndex].name}, BB -> ${table.players[bigBlindIndex].name}`);
    postBlind(table.players[smallBlindIndex], table.smallBlindAmount, tableId);
    //  ✅  Small Blind posts
    postBlind(table.players[bigBlindIndex], table.bigBlindAmount, tableId, true);
    //  ✅  Big Blind posts & updates `currentBet`
    table.currentPlayerIndex = (bigBlindIndex + 1) % table.players.length;
    //  ✅  First action goes to UTG (next after BB)
    table.playersWhoActed.clear();
    console.log(` 🎯  First action: ${table.players[table.currentPlayerIndex].name}`);
    broadcastGameState(tableId);  //  ✅  Ensures frontend gets the correct initial state
    broadcast({
        type: "blindsPosted",
        smallBlind: table.players[smallBlindIndex].name,
        bigBlind: table.players[bigBlindIndex].name
    }, tableId);
    setTimeout(bettingRound, 500, tableId); //  ✅  Start the first betting round
}
function formatHand(hand) {
    return hand.map(card => `${card.rank} of ${card.suit}`).join(", "); 
}
function postBlind(player, amount, tableId, isBigBlind = false) {
    const table = tables.get(tableId);
    if (!table) return;

    const blindAmount = Math.min(amount, player.tokens);
    player.tokens -= blindAmount;
    player.currentBet = blindAmount;
    table.pot += blindAmount;
    if (player.tokens === 0) {
        player.allIn = true;
    }
    if (isBigBlind) {  //  ✅  Added: Ensure `currentBet` is set to the BB amount
        table.currentBet = blindAmount;
    }
    console.log(` 💰  ${player.name} posts ${blindAmount}. Pot: ${table.pot}, Current Bet: ${table.currentBet}`);
}
function getNextPlayerIndex(currentIndex, tableId) {
    const table = tables.get(tableId);
    if (!table) return -1;

    console.log(` 🔄  Finding next player from index ${currentIndex}`); 
    let nextIndex = (currentIndex + 1) % table.players.length;
    let attempts = 0;
    while (attempts < table.players.length) {
        let nextPlayer = table.players[nextIndex];
        if (nextPlayer.status === "active" && nextPlayer.tokens > 0 && !nextPlayer.allIn) {
            console.log(` 🎯  Next player is ${nextPlayer.name}`);
            return nextIndex;
        }
        console.log(` ⏩  Skipping ${nextPlayer.name} (Status: ${nextPlayer.status}, Tokens: ${nextPlayer.tokens})`);
        nextIndex = (nextIndex + 1) % table.players.length;
        attempts++;
    }
    console.log(" ✅  All players have acted. Moving to the next round.");
    setTimeout(nextRound, 1000, tableId);
    return -1;
}
function bettingRound(tableId) {
    const table = tables.get(tableId);
    if (!table) return;

    console.log("Starting betting round..."); 

    // ✅ Include all-in players in the current round
    let activePlayers = table.players.filter(p => p.status === "active");
    let nonAllInPlayers = table.players.filter(p => p.status === "active" && !p.allIn && p.tokens > 0);

    if (nonAllInPlayers.length === 0 && activePlayers.length > 1) {
        console.log("⚠️ Only all-in players remain. Betting round continues without them acting.");
    } else if (nonAllInPlayers.length === 0) {
    console.log("✅ No players left with chips. Skipping to next round.");
    setTimeout(nextRound, 1000, tableId);
    return;
} else if (
    nonAllInPlayers.length === 1 &&
    table.playersWhoActed.has(nonAllInPlayers[0].name) &&
    nonAllInPlayers[0].currentBet === table.currentBet
) {
    console.log("✅ Only one non-all-in player and they’ve acted. Moving to next round.");
    setTimeout(nextRound, 1000, tableId);
    return;
}
    

    if (isBettingRoundOver(tableId)) {
        console.log("✅ All players have acted. Betting round is over.");
        setTimeout(nextRound, 1000, tableId);
        return;
    }

    const player = table.players[table.currentPlayerIndex];
if (table.playersWhoActed.has(player.name)) {
        console.log(`${player.name} has already acted. Skipping...`);
    table.currentPlayerIndex = getNextPlayerIndex(table.currentPlayerIndex, tableId);
    bettingRound(tableId);
    return;
}
    

    console.log(`Waiting for player ${player.name} to act...`);
    broadcast({ type: "playerTurn", playerName: player.name, tableId: tableId }, tableId);
}


function isBettingRoundOver(tableId) {
    const table = tables.get(tableId);
    if (!table) return true;

    console.log(" 📊  Checking if betting round is over...");
    console.log("playersWhoActed:", [...table.playersWhoActed]);
    console.log("Current Bet:", table.currentBet);
    console.log("Active Players:", table.players.filter(p => p.status === "active").map(p => p.name));
    let activePlayers = table.players.filter(p => p.status === "active" && !p.allIn && p.tokens > 0);
        console.log("Active Players (non-all-in):", activePlayers.map(p => p.name));


    //  ✅  Only one player left, round ends immediately
    //  ✅  Ensure all active players have either checked or matched the current bet
    const allCalledOrChecked = activePlayers.every(player => {
        const acted = table.playersWhoActed.has(player.name);
        const matchedBet = player.currentBet === table.currentBet || table.currentBet === 0;
        console.log(`  - ${player.name} => Acted: ${acted}, MatchedBet: ${matchedBet}`);
        return acted && matchedBet;
    });
    console.log(" ✅  Betting round over:", allCalledOrChecked);
    return allCalledOrChecked;
}

function bigBlindCheckRaiseOption(tableId) {
    const table = tables.get(tableId);
    if (!table) return;

    let bigBlindPlayer = table.players[(table.dealerIndex + 2) % table.players.length];
    if (table.currentBet === table.bigBlindAmount) {
        console.log(`${bigBlindPlayer.name}, you can check or bet.`);
        bigBlindPlayer.ws.send(JSON.stringify({
            type: "bigBlindAction",
            options: ["check", "raise"]
        }));
    } else {
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
function startFlopBetting(tableId) {
    const table = tables.get(tableId);
    if (!table) return;

    table.currentBet = 0; 
    table.playersWhoActed.clear();

    // ✅ Set the first active player left of the dealer
    const nextIndex = getNextPlayerIndex(table.dealerIndex, tableId);
    if (nextIndex !== -1) {
        table.currentPlayerIndex = nextIndex;
        console.log(` 🎯  Starting post-flop betting with: ${table.players[nextIndex].name}`);
        broadcast({
            type: "playerTurn",
            playerName: table.players[nextIndex].name
        }, tableId);
    } else {
        console.warn(`⚠️ No valid player to start betting with at table ${tableId}`);
    }
}

function nextRound(tableId) {
    const table = tables.get(tableId);
    if (!table) return;
    console.log("nextRound() called. Current round:", table.round);
    console.log("💬 Deck size:", table.deckForGame?.length);
    console.log("💬 Pot:", table.pot);
    console.log("💬 TableCards before dealing:", table.tableCards);

    table.currentBet = 0;
    table.players.forEach(player => (player.currentBet = 0));
    table.playersWhoActed.clear();
    console.log(" 🆕  New round started. Reset playersWhoActed."); //  ✅  Debugging log
    if (table.round === 0) {
        table.round++; 
        table.tableCards = dealHand(table.deckForGame, 3); // Flop
        console.log("🃏 Flop dealt:", table.tableCards);
        broadcast({ type: "message", text: `Flop: ${JSON.stringify(table.tableCards)}`, tableId: tableId }, tableId);
    } else if (table.round === 1) {
        table.round++;
        if (table.deckForGame.length > 0) {
            table.tableCards.push(dealHand(table.deckForGame, 1)[0]);
            // Turn
            broadcast({ type: "message", text: `Turn: ${JSON.stringify(table.tableCards[3])}` , tableId: tableId }, tableId)
        }
    } else if (table.round === 2) {
        table.round++;
        if (table.deckForGame.length > 0) {
            table.tableCards.push(dealHand(table.deckForGame, 1)[0]);
            // Turn
            broadcast({ type: "message", text: `River: ${JSON.stringify(table.tableCards[4])}` ,tableId: tableId }, tableId);
        }
    } else if (table.round === 3) {
        showdown(tableId);
        return;
    }
    broadcastGameState(tableId);
    setTimeout(() => startFlopBetting(tableId), 1500);
}
function showdown(tableId) {
    const table = tables.get(tableId);
    if (!table) return;

    console.log(" 🏆  Showdown!");
    let activePlayers = table.players.filter(p => p.status === "active" || p.allIn);
    let winners = determineWinners(activePlayers, table);
    winners.forEach(winner => {
        console.log(` 🎉  ${winner.name} wins the hand!`);
    });
    //  ✅  Automatically reveal the winner's hand
        let revealedHands = winners.map(winner => {
        const fullHand = winner.hand.concat(table.tableCards);
        const evalResult = evaluateHand(fullHand); // ✅ Store the result first

        return {
            playerName: winner.name,
            hand: evalResult.bestCards, // ✅ Extract best cards
            handType: evalResult.handType // ✅ Extract handType properly
        };
    });
    //  ✅  Broadcast revealed winner hands to all players
    broadcast({
        type: "showdown",
        winners: revealedHands,
    }, tableId);
    //  ✅  Record winning hand in history
    broadcast({
        type: "updateActionHistory",
        action: `🏆  Winner: ${winners.map(w => w.name).join(", ")} with ${revealedHands[0].handType}`
    }, tableId);
    distributePot(tableId);
    //  ✅  Give players the option to "Show" or "Hide" their hands
    let remainingPlayers = activePlayers.filter(p => !winners.includes(p)).map(p => p.name);
    if (remainingPlayers.length > 0) {
        broadcast({
            type: "showOrHideCards",
            remainingPlayers
        }, tableId);
        //  ✅  Auto-start next hand if no action in 10 seconds
        setTimeout(() => {
            if (remainingPlayers.length > 0) {
                console.log(" ⏳  No player responded. Automatically starting the next hand...");
                resetGame(tableId);
            }

        }, 10000); // 10 seconds
    } else {
        setTimeout(resetGame, 5000, tableId);
    }
}
function distributePot(tableId) {
    const table = tables.get(tableId);
    if (!table) return;

    console.log("💰 Distributing the pot...");

    let activePlayers = table.players.filter(p => p.status === "active" || p.allIn);

    // Sort players by their all-in amounts (for side pots)
    activePlayers.sort((a, b) => a.currentBet - b.currentBet);

    let totalPot = table.pot;
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
        let winners = determineWinners(sidePot.players, table);
        let splitPot = Math.floor(sidePot.amount / winners.length);
        winners.forEach(winner => {
            winner.tokens += splitPot;
            console.log(`🏆 ${winner.name} wins ${splitPot} from a side pot.`);
        });
    });

    let remainingPot = totalPot - sidePots.reduce((acc, sp) => acc + sp.amount, 0);
    if (remainingPot > 0) {
        let mainWinners = determineWinners(table.players.filter(p => p.status === "active"), table);
        let splitPot = Math.floor(remainingPot / mainWinners.length);
        mainWinners.forEach(winner => {
            winner.tokens += splitPot;
            console.log(`🏆 ${winner.name} wins ${splitPot} from the main pot.`);
        });
    }

    table.pot = 0; // Reset the pot after distribution
}

function resetGame(tableId) {
    const table = tables.get(tableId);
    if (!table) return;

    console.log("Resetting game for the next round.");
    table.round = 0;
    table.tableCards = [];
    table.pot = 0;
    let activePlayers = table.players.filter(p => p.tokens > 0); 
    if (activePlayers.length > 0) {
        table.dealerIndex = (table.dealerIndex + 1) % activePlayers.length;
        console.log(` 🎲  New dealer is: ${activePlayers[table.dealerIndex].name}`);
    } else {
        console.log(" ⚠️ No active players left! Game cannot continue.");
        return;
    }
    //  ✅  Reset all players for a new round
    table.players.forEach(player => {
        player.hand = [] ;
        player.currentBet = 0;
        player.allIn = false;
                if (player.tokens > 0) {
            player.status = "active"; // ✅ Can still play
        } else {
            player.status = "inactive"; // ✅ Out of chips, cannot play but stays at the table
            console.log(` ❌ ${player.name} is out of chips and inactive.`);
        }

    });
    console.log(` 🎲  New dealer is: ${table.players[table.dealerIndex].name}`);
    startNewHand(tableId); //  ✅  Start the new round with correct dealer
}
function determineWinners(playerList, table) {
    if (playerList.length === 0) {
        return [];
    }
    let bestHandValue = -1;
    let winners = [];
    let bestHandDetails = null;
    // To store best hand details for tiebreakers
    playerList.forEach(player => {
        if (player.status !== "folded") {
            const fullHand = player.hand.concat(table.tableCards);
            const { handValue, bestCards } = evaluateHand(fullHand);
            if (handValue > bestHandValue) {
                bestHandValue = handValue;

                winners = [player];
                bestHandDetails = bestCards;
            } else if (handValue === bestHandValue) {
                //  ✅  Handle tie cases by comparing kicker
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

    if (isRoyalFlush(sortedHand, ranks, suits)) return { handValue: 10, bestCards: sortedHand, handType: "Royal Flush" };
    if (isStraightFlush(sortedHand, ranks, suits)) return { handValue: 9, bestCards: sortedHand, handType: "Straight Flush" };
    if (isFourOfAKind(sortedHand, ranks)) return { handValue: 8, bestCards: sortedHand, handType: "Four of a Kind" };
    if (isFullHouse(sortedHand, ranks)) return { handValue: 7, bestCards: sortedHand, handType: "Full House" };
    if (isFlush(sortedHand, suits)) return { handValue: 6, bestCards: sortedHand, handType: "Flush" };
    if (isStraight(sortedHand, ranks)) return { handValue: 5, bestCards: sortedHand, handType: "Straight" };
    if (isThreeOfAKind(sortedHand, ranks)) return { handValue: 4, bestCards: sortedHand, handType: "Three of a Kind" };
    if (isTwoPair(sortedHand, ranks).result) return { handValue: 3, bestCards: sortedHand, handType: "Two Pair" };
    if (isOnePair(sortedHand, ranks)) return { handValue: 2, bestCards: sortedHand, handType: "One Pair" };
    return { handValue: 1, bestCards: sortedHand.slice(0, 5), handType: "High Card" };
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
    const handValues = hand.map(card => rankValues[card.rank]) //  ✅  Renamed to avoid conflict
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
    let pairs = [];
    let checkedRanks = new Set();
    
    for (let rank of ranks) {
        if (checkedRanks.has(rank)) continue;
        if (ranks.filter(r => r === rank).length === 2) {
            pairs.push(rankValues[rank]); // Store numerical value of the pair
            checkedRanks.add(rank);
        }
    }

    if (pairs.length === 2) {
        pairs.sort((a, b) => b - a); // Sort pairs to ensure the highest pair is first
        const kicker = ranks.find(rank => !pairs.includes(rankValues[rank])); // Find the kicker
        return { result: true, highPair: pairs[0], lowPair: pairs[1], kicker: kicker ? rankValues[kicker] : 0 };
    }

    return { result: false, highPair: 0, lowPair: 0, kicker: 0 };
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
    return 0;
    // Exact tie
}
// WebSocket server event handling
wss.on('connection', function connection(ws) {
    console.log(' ✅  A new client connected');
    ws.on('message', function incoming(message) {
        console.log(' 📩  Received message from client:', message);
        try {
            const data = JSON.parse(message);
            //  ✅  Handle "Show or Hide" Decision
            if (data.type ===
                "showHideDecision") {
                let player = null;
                let tableId = ws.tableId;
                if (tableId) {
                    let table = tables.get(tableId);
                    if (table) {
                        player = table.players.find(p => p.name === data.playerName);
                    }
                }
                if (!player) return;
                if (data.choice === "show") {
                    console.log(` 👀  ${player.name} chose to SHOW their hand!`);
                    broadcast({
                        type: "updateActionHistory",
                        action: ` 👀  ${player.name} revealed: ${formatHand(player.hand)}`
                    }, ws.tableId);
                } else {
                    console.log(` 🙈  ${player.name} chose to HIDE their hand.`);

                    broadcast({
                        type: "updateActionHistory",
                        action: ` 🙈  ${player.name} chose to keep their hand hidden.`
                    }, ws.tableId);
                }
                //  ✅  Remove player from the waiting list
                let playersWhoNeedToDecide = [];
                if (ws.tableId) {
                    let table = tables.get(ws.tableId);
                    if (table) {
                        playersWhoNeedToDecide = playersWhoNeedToDecide.filter(p => p !== data.playerName);
                        table.playersWhoNeedToDecide = playersWhoNeedToDecide;
                    }
                }
                //  ✅  If all players have chosen, start the next round
                if (playersWhoNeedToDecide.length === 0 && ws.tableId) {
                    setTimeout(resetGame, 3000, ws.tableId);
                }
            }
            //  ✅  Handle other game actions separately
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
                let tableId = data.tableId;
                ws.tableId = tableId;
                let table = tables.get(tableId);
                if (!table) {
                    table = {
                        players: [],
                        tableCards: [],
                        pot: 0,
                        currentPlayerIndex: 0,
                        deckForGame: [],
                        currentBet: 0,
                        dealerIndex: 0,
                        round: 0,
                        smallBlindAmount: 10,
                        bigBlindAmount: 20,
                        playersWhoActed: new Set()
                    };
                    tables.set(tableId, table);
                }
                table.players.push(player);
                console.log(` ➕  Player ${data.name} joined. Total players: ${table.players.length}`);
                broadcast({ type: 'updatePlayers', players: table.players.map(({ ws, ...player }) => player) , tableId: tableId }, tableId);
            } else if (data.type === 'startGame') {
                startGame(data.tableId);
            } else if (data.type === 'bet') {
                handleBet(data, ws.tableId);
            } else if (data.type === 'raise') {
                handleRaise(data, ws.tableId);
            } else if (data.type === 'call') {
                handleCall(data, ws.tableId);
            } else if (data.type === 'fold') {
                handleFold(data, ws.tableId);
            } else if (data.type === 'check') {
                handleCheck(data, ws.tableId);
            }
        } catch (error) {
            console.error(' ❌  Error parsing message:', error);
        }
    });
    ws.on('close', () => {
        console.log(' ❌  Client disconnected');
        let tableId = ws.tableId;
        if (tableId) {
            let table = tables.get(tableId);
            if (table) {
                table.players = table.players.filter(player => player.ws !== ws);
                broadcast({ type: 'updatePlayers', players: table.players.map(({ ws, ...player }) => player), tableId: tableId }, tableId);
            }
        }
    });
});
// Action handlers
function handleRaise(data, tableId) {
    const table = tables.get(tableId);
    if (!table) return;
    
    const player = table.players.find(p => p.name === data.playerName);
    if (!player) return;
    
    const raiseAmount = parseInt(data.amount);
    if (raiseAmount > player.tokens || raiseAmount <= table.currentBet) return;

    const totalBet = raiseAmount;
    player.tokens -= (totalBet - player.currentBet);
    table.pot += (totalBet - player.currentBet);
    player.currentBet = totalBet;
    table.currentBet = totalBet;

    table.playersWhoActed.clear(); // ✅ Reset all players except raiser
    table.playersWhoActed.add(player.name);
     console.log("After updating playersWhoActed:", [...table.playersWhoActed]);
    broadcast({
        type: "updateActionHistory",
        action: `${data.playerName} raise ${raiseAmount}`
    }, tableId);
    broadcast({ type: "raise", playerName: data.playerName, amount: raiseAmount, tableId: tableId
 }, tableId);

    table.currentPlayerIndex = getNextPlayerIndex(table.currentPlayerIndex, tableId);
    broadcastGameState(tableId);
    bettingRound(tableId);
}

function handleBet(data, tableId) {
const table = tables.get(tableId);
if (!table) return;

console.log(` 🔄  ${data.playerName} performed action: ${data.type}`);
console.log("Before updating playersWhoActed:", [...table.playersWhoActed]);
const player = table.players.find(p => p.name === data.playerName);
if (!player) {
    console.error("Player not found:", data.playerName);
    return;
}
const betAmount = parseInt(data.amount);
if (betAmount <= player.tokens && betAmount > table.currentBet) {
    player.tokens -= betAmount;
    table.pot += betAmount;
    table.currentBet = betAmount;
    player.currentBet = betAmount;
    if (player.tokens === 0) {
        player.allIn = true;
    }
    table.playersWhoActed.add(player.name);
    console.log("After updating playersWhoActed:", [...table.playersWhoActed]);
    broadcast({
        type: "updateActionHistory",
        action: `${data.playerName} bet ${betAmount}`
    }, tableId);
    broadcast({ type: "bet", playerName: data.playerName, amount: betAmount, tableId: tableId
 }, tableId);
    //  ✅  After a bet, all need to act again
    table.players.forEach(p => {
        if (p.name !== player.name) {
            table.playersWhoActed.delete(p.name);
        }
    });
    console.log("After updating playersWhoActed:", [...table.playersWhoActed]);
    table.currentPlayerIndex = getNextPlayerIndex(table.currentPlayerIndex, tableId);
    broadcastGameState(tableId);  //  ✅  Only update the UI once
    bettingRound(tableId);
}
}
function handleCall(data, tableId) {
const table = tables.get(tableId);
if (!table) return;

console.log(` 🔄  ${data.playerName} performed action: ${data.type}`);
console.log("Before updating playersWhoActed:", [...table.playersWhoActed]);
const player = table.players.find(p => p.name === data.playerName);
if (!player) {
    console.error("Player not found:", data.playerName);
    return;
}
const callAmount = table.currentBet - player.currentBet;
if (callAmount <= player.tokens) {
    player.tokens -= callAmount;
    table.pot += callAmount;
    player.currentBet = table.currentBet;
    if (player.tokens === 0) {
        player.allIn = true;
    }
    player.status = "active";
    table.playersWhoActed.add(player.name);
    console.log("After updating playersWhoActed:", [...table.playersWhoActed]);
    broadcast({
        type: "updateActionHistory",
        action: `${data.playerName} called`
    }, tableId);
    broadcast({ type: "call", playerName: data.playerName, tableId: tableId }, tableId);
    table.currentPlayerIndex = getNextPlayerIndex(table.currentPlayerIndex, tableId);
    if (table.currentPlayerIndex !== -1) {
        bettingRound(tableId);
    } else {
        console.log(" ✅  All players have acted. Moving to next round.");
        setTimeout(nextRound, 1000, tableId);
    }
    broadcastGameState(tableId);  //  ✅  Only update the UI once
}
}
function handleFold(data, tableId) {
const table = tables.get(tableId);
if (!table) return;

console.log(` 🔄  ${data.playerName} performed action: ${data.type}`);
console.log("Before updating playersWhoActed:", [...table.playersWhoActed]);
const player = table.players.find(p => p.name === data.playerName);
if (!player) {
    console.error("Player not found:", data.playerName);
    return; //  ✅  Prevents processing an invalid action
}
player.status = "folded";
table.playersWhoActed.add(player.name);
console.log(` ❌  ${player.name} folded.`);
broadcast({
    type: "updateActionHistory",
    action: `${data.playerName} folded`
}, tableId);
broadcast({ type: "fold", playerName: data.playerName , tableId: tableId }, tableId);
    let activePlayers = table.players.filter(p => p.status === "active");
    if (activePlayers.length === 1) {
        console.log(` 🏆  Only one player remains: ${activePlayers[0].name}. Going to showdown.`);
        showdown(tableId);
        return;
    }
table.currentPlayerIndex = getNextPlayerIndex(table.currentPlayerIndex, tableId);
if (table.currentPlayerIndex !== -1) {
    bettingRound(tableId);
} else {
    console.log(" ✅  All players have acted. Moving to next round.");
    setTimeout(nextRound, 1000, tableId);
}
broadcastGameState(tableId);  //  ✅  Only update the UI once
}
function handleCheck(data, tableId) {
const table = tables.get(tableId);
if (!table) return;

console.log(` 🔄  ${data.playerName} performed action: ${data.type}`);
console.log("Before updating playersWhoActed:", [...table.playersWhoActed]);
const player = table.players.find(p => p.name === data.playerName);
if (!player) {
    console.error(" ❌  Player not found:", data.playerName);
    return; //  ✅  Prevents processing an invalid action
}
if (table.currentBet === 0 || player.currentBet === table.currentBet) {
    console.log(`${player.name} checked.`);
    table.playersWhoActed.add(player.name);
    console.log("After updating playersWhoActed:", [...table.playersWhoActed]);
    broadcast({
        type: "updateActionHistory",
        action: `${data.playerName} checked`
    }, tableId);
    if (isBettingRoundOver(tableId)) {
        setTimeout(nextRound, 1000, tableId);
    } else {
        table.currentPlayerIndex = getNextPlayerIndex(table.currentPlayerIndex, tableId);
        broadcastGameState(tableId);
        bettingRound(tableId);
    }
}
}
// Start the server
server.listen(process.env.PORT || 8080, () => {
console.log(`WebSocket server started on port ${server.address().port}`);
});
