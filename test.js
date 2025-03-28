const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();
app.use(cors({
    origin: "https://apramay.github.io", //  ✅  Allow requests from your frontend
    methods: ["GET", "POST", "OPTIONS"]  //  ✅  Specify allowed HTTP methods
}));
app.use(bodyParser.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Store table states
const tables = new Map();

// Card and game constants
const suits = ["Hearts", "Diamonds", "Clubs", "Spades"];
const ranks = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]; 
const rankValues = {
    "2": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7, "8": 8, "9": 9, "10": 10, "J": 11, "Q": 12, "K": 13, "A": 14
}; 



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
app.post("/registerTable", (req, res) => {
    const { tableId, solToToken, smallBlind, bigBlind } = req.body;

    if (tables.has(tableId)) {
        return res.status(400).json({ error: "Table already exists!" });
    }

    tables.set(tableId, {
        solToToken,
        smallBlindAmount: smallBlind,
        bigBlindAmount: bigBlind,
        players: [],
        tableCards: [],
        pot: 0,
        currentBet: 0,
        dealerIndex: 0,
        deckForGame: createDeck(),
        lastRaiseAmount: 0,
        playersWhoActed: new Set()
    });

    res.json({ message: "Table registered successfully!" });
});

// Get table settings
app.get("/getTableSettings", (req, res) => {
    const table = tables.get(req.query.tableId);
    table ? res.json(table) : res.status(404).json({ error: "Table not found" });
});

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
    table.lastRaiseAmount = 0;
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
        player.totalContribution = 0; // ✅ IMPORTANT
        player.status = player.tokens > 0 ? "active" : "inactive";
        player.isSmallBlind = (activePlayers[smallBlindIndex] && player.name === activePlayers[smallBlindIndex].name);
        player.isBigBlind = (activePlayers[bigBlindIndex] && player.name === activePlayers[bigBlindIndex].name);
       const blindAmount = player.isSmallBlind ? table.smallBlindAmount : player.isBigBlind ? table.bigBlindAmount : 0;

        player.tokens -= blindAmount;
        player.currentBet = blindAmount;
        player.totalContribution = blindAmount; // ✅ Fix: Incorporate blinds into totalContribution
        table.pot += blindAmount;
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
    table.playersWhoActed.has(nonAllInPlayers[0].name)
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

    console.log("📊 Checking if betting round is over...");
    console.log("playersWhoActed:", [...table.playersWhoActed]);
    console.log("Current Bet:", table.currentBet);
    
    // MODIFIED: Improved active player filtering
    let activePlayers = table.players.filter(p => 
        p.status === "active" && !p.allIn && p.tokens > 0
    );
    console.log("Active Players (non-all-in):", activePlayers.map(p => p.name));

    // MODIFIED: More accurate completion check
    const allActed = activePlayers.every(p => table.playersWhoActed.has(p.name));
    const allCalled = table.players.every(p => 
        p.status !== "active" || 
        p.allIn || 
        p.currentBet === table.currentBet
    );

    console.log("✅ Betting round over:", allActed && allCalled);
    return (activePlayers.length === 0) || (allActed && allCalled);
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
            table.tableCards.push(dealHand(table.deckForGame, 1)[0]);
            // Turn
            broadcast({ type: "message", text: `Turn: ${JSON.stringify(table.tableCards[3])}` , tableId: tableId }, tableId)
        
    } else if (table.round === 2) {
        table.round++;
            table.tableCards.push(dealHand(table.deckForGame, 1)[0]);
            // Turn
            broadcast({ type: "message", text: `River: ${JSON.stringify(table.tableCards[4])}` ,tableId: tableId }, tableId);
        }
    else if (table.round === 3) {
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

    // Only players who didn't fold are eligible
    const playersInHand = table.players.filter(p => p.status !== "folded");

    // Cache hand evaluations
    const handStrengthMap = new Map();
    playersInHand.forEach(p => {
        const fullHand = p.hand.concat(table.tableCards);
        handStrengthMap.set(p.name, evaluateHand(fullHand));
    });

    // Sort players by contribution (ascending)
    const sorted = [...playersInHand].sort((a, b) => a.totalContribution - b.totalContribution);
    const contributionLevels = [...new Set(sorted.map(p => p.totalContribution))];

    let totalPot = table.pot;
    let remainingPlayers = [...playersInHand];
    let lastLevel = 0;

    for (const level of contributionLevels) {
        // Eligible players: contributed >= this level
        const eligible = remainingPlayers.filter(p => p.totalContribution >= level);

        const levelAmount = (level - lastLevel) * eligible.length;

        // Track and verify correct pot distribution
        totalPot -= levelAmount;
        lastLevel = level;

        console.log(`💡 Side Pot Level ${level}: ${levelAmount} chips between ${eligible.map(p => p.name).join(", ")}`);

        const winners = determineWinners(eligible, table, handStrengthMap);
        const baseShare = Math.floor(levelAmount / winners.length);
        let remainder = levelAmount % winners.length;

        winners.forEach((winner, i) => {
            const winAmount = baseShare + (i < remainder ? 1 : 0);
            winner.tokens += winAmount;
            console.log(`🏆 ${winner.name} wins ${winAmount} from side pot level ${level}`);
        });

        // Remove players who are no longer in remaining levels
        remainingPlayers = remainingPlayers.filter(p => p.totalContribution > level);
    }

    // Final cleanup
    table.pot = 0;
    table.players.forEach(p => {
        p.currentBet = 0;
        p.totalContribution = 0;
    });
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
    if (playerList.length === 0) return [];

    let bestHandValue = -1;
    let winners = [];
    let bestHand = null;

    playerList.forEach(player => {
        if (player.status === "folded") return;

        const fullHand = player.hand.concat(table.tableCards);
        const { handValue, bestCards, kicker, handType } = evaluateHand(fullHand);

        console.log(`Player ${player.name} evaluated hand:`);
        console.log(`Full Hand: ${JSON.stringify(fullHand.map(card => card.rank + card.suit))}`);
        console.log(`Hand Type: ${handType}`);
        console.log(`Hand Value: ${handValue}`);
        console.log(`Best Cards: ${JSON.stringify(bestCards.map(card => card.rank + card.suit))}`);
        console.log(`Kicker: ${kicker}`);

        const comparison = bestHand
            ? compareHands(bestCards, bestHand)
            : 1;

        if (handValue > bestHandValue) {
            winners = [player];
            bestHandValue = handValue;
            bestHand = bestCards;
            console.log(`New best hand found for ${player.name}: ${handType}`);
        } else if (handValue === bestHandValue) {
            if (comparison > 0) {
                winners = [player];
                bestHand = bestCards;
                console.log(`New better kicker found for ${player.name}.`);
            } else if (comparison === 0) {
                winners.push(player);
                console.log(`Tie detected, adding ${player.name} as a winner.`);
            }
        }
    });

    return winners;
}

// Function to evaluate the hand of a player
function evaluateHand(cards) {
    const combinations = getAllFiveCardCombos(cards);
    let best = {
        handValue: 0,
        bestCards: [],
        handType: "",
        kicker: -1
    };

    for (let combo of combinations) {
        const result = evaluateFiveCardHand(combo);
        if (result.handValue > best.handValue ||
            (result.handValue === best.handValue && compareHands(result.bestCards, best.bestCards) > 0)) {
            best = result;
        }
    }

    return best;
}

function getAllFiveCardCombos(cards) {
    const results = [];
    const combo = [];

    function backtrack(start) {
        if (combo.length === 5) {
            results.push([...combo]);
            return;
        }
        for (let i = start; i < cards.length; i++) {
            combo.push(cards[i]);
            backtrack(i + 1);
            combo.pop();
        }
    }

    backtrack(0);
    return results;
}

function evaluateFiveCardHand(hand) {
    const suits = hand.map(c => c.suit);
    const ranks = hand.map(c => c.rank);
    const values = hand.map(c => rankValues[c.rank]).sort((a, b) => b - a);
    const rankCount = {};
    ranks.forEach(r => rankCount[r] = (rankCount[r] || 0) + 1);

    const isFlush = suits.every(s => s === suits[0]);
    const isStraight = checkStraight(values);

    // Royal Flush
    if (isFlush && isStraight && values.includes(14) && values.includes(10)) {
        return { handValue: 10, bestCards: hand, handType: "Royal Flush", kicker: -1 };
    }

    // Straight Flush
    if (isFlush && isStraight) {
        return { handValue: 9, bestCards: hand, handType: "Straight Flush", kicker: values[0] };
    }

    // Four of a Kind
    if (Object.values(rankCount).includes(4)) {
        const fourRank = Object.keys(rankCount).find(r => rankCount[r] === 4);
        const kicker = values.find(v => v !== rankValues[fourRank]);
        return {
            handValue: 8,
            bestCards: hand,
            handType: "Four of a Kind",
            kicker: kicker
        };
    }

    // Full House
    const hasThree = Object.values(rankCount).includes(3);
    const hasPair = Object.values(rankCount).filter(v => v >= 2).length >= 2;
    if (hasThree && hasPair) {
        return { handValue: 7, bestCards: hand, handType: "Full House", kicker: -1 };
    }

    // Flush
    if (isFlush) {
        return { handValue: 6, bestCards: hand, handType: "Flush", kicker: values[0] };
    }

    // Straight
    if (isStraight) {
        return { handValue: 5, bestCards: hand, handType: "Straight", kicker: values[0] };
    }

    // Three of a Kind
    if (Object.values(rankCount).includes(3)) {
        return { handValue: 4, bestCards: hand, handType: "Three of a Kind", kicker: values[0] };
    }

    // Two Pair
    const pairs = Object.entries(rankCount).filter(([r, c]) => c === 2).map(([r]) => rankValues[r]);
    if (pairs.length === 2) {
        pairs.sort((a, b) => b - a);
        const kicker = values.find(v => v !== pairs[0] && v !== pairs[1]);
        return { handValue: 3, bestCards: hand, handType: "Two Pair", kicker: kicker };
    }

    // One Pair
    // One Pair
if (pairs.length === 1) {
    const pairValue = pairs[0];
    const remaining = values.filter(v => v !== pairValue).slice(0, 3); // Get top 3 kickers
    return { 
        handValue: 2, 
        bestCards: hand, 
        handType: "One Pair", 
        kicker: remaining.length > 0 ? remaining[0] : 0, 
        pairValue: pairValue // Store the value of the pair explicitly
    };
}


    // High Card
    return { handValue: 1, bestCards: hand, handType: "High Card", kicker: values[0] };
}

function checkStraight(values) {
    const unique = [...new Set(values)];
    for (let i = 0; i <= unique.length - 5; i++) {
        if (unique[i] - unique[i + 4] === 4) return true;
    }
    // Check wheel (A-2-3-4-5)
    if (unique.includes(14) && unique.includes(2) && unique.includes(3) && unique.includes(4) && unique.includes(5)) {
        return true;
    }
    return false;
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
    const valuesA = handA.map(c => rankValues[c.rank]).sort((a, b) => b - a);
    const valuesB = handB.map(c => rankValues[c.rank]).sort((a, b) => b - a);
    // If both hands have a pair, compare the pair values first
    const pairA = valuesA.find((v, _, arr) => arr.filter(x => x === v).length === 2);
    const pairB = valuesB.find((v, _, arr) => arr.filter(x => x === v).length === 2);
    if (pairA && pairB) {
        if (pairA > pairB) return 1;
        if (pairA < pairB) return -1;
    }

    for (let i = 0; i < 5; i++) {
        if (valuesA[i] > valuesB[i]) return 1;
        if (valuesA[i] < valuesB[i]) return -1;
    }
    return 0; // exact tie
}

// WebSocket server event handling
wss.on('connection', function connection(ws) {
    console.log(' ✅  A new client connected');
    ws.on('message', function incoming(message) {
        console.log(' 📩  Received message from client:', message);
        try {
            const data = JSON.parse(message);

            if (data.type === "cashout") {
            let tableId = data.tableId;
            let table = tables.get(tableId);
            if (!table) return;

            // Find and remove the player
            table.players = table.players.filter(player => player.name !== data.playerName);
            console.log(`❌ Player ${data.playerName} cashed out and left the table.`);

            // Broadcast updated player list
            broadcast({ type: "updatePlayers", players: table.players.map(({ ws, ...player }) => player), tableId: tableId }, tableId);

            // If only one player remains, end the game
            if (table.players.length === 1) {
                console.log("🏆 Only one player remains, ending the game.");
                showdown(tableId);
            }
        }
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
                const tokenAmount = data.tokens; // Use selected token amount

    if (!tokenAmount || tokenAmount <= 0) {
        console.warn(`❌ Invalid token amount for ${data.name}`);
        return;
    }
                const player = {
                    name: data.name,
                    ws: ws,
                    tokens: tokenAmount,
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
                console.log(` ➕  Player ${data.name} with ${tokenAmount} tokens . Total players: ${table.players.length}`);
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
    const minRaise = table.lastRaiseAmount || table.bigBlindAmount;

    if (raiseAmount < minRaise && raiseAmount !== player.tokens) {
        console.log(`❌ ${player.name} must raise by at least ${minRaise}`);
        return;
    }

    const requiredToCall = Math.max(table.currentBet - player.currentBet, 0);
    const totalBet = requiredToCall + raiseAmount;
    const chipsToAdd = Math.min(totalBet, player.tokens);

    player.tokens -= chipsToAdd;
    player.currentBet += chipsToAdd;
    player.totalContribution += chipsToAdd;
    table.pot += chipsToAdd;

    if (player.tokens === 0) {
        player.allIn = true;
    }

    table.currentBet = Math.max(table.currentBet, player.currentBet);
    table.lastRaiseAmount = raiseAmount;
    table.playersWhoActed.clear();
    table.playersWhoActed.add(player.name);

    console.log(`${player.name} raises to ${player.currentBet}`);
    console.log(`💸 Contributions: ${table.players.map(p => `${p.name}:${p.totalContribution}`).join(", ")}`);

    broadcast({
        type: "updateActionHistory",
        action: `${data.playerName} raised to ${player.currentBet}`
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

    const player = table.players.find(p => p.name === data.playerName);
    if (!player) return;

    const requiredToCall = table.currentBet - player.currentBet;
    const chipsToAdd = Math.min(requiredToCall, player.tokens);

    // Update contributions and pot
    player.tokens -= chipsToAdd;
    player.currentBet += chipsToAdd;
    player.totalContribution += chipsToAdd;
    table.pot += chipsToAdd;

    if (player.tokens === 0) {
        player.allIn = true;
        console.log(`💥 ${player.name} goes all-in for ${chipsToAdd}`);
    }

    table.playersWhoActed.add(player.name);
    broadcast({
        type: "updateActionHistory",
        action: `${data.playerName} called ${chipsToAdd}`
    }, tableId);

    table.currentPlayerIndex = getNextPlayerIndex(table.currentPlayerIndex, tableId);
    if (table.currentPlayerIndex !== -1) {
        bettingRound(tableId);
    } else {
        console.log("✅ All players have acted. Moving to next round.");
        setTimeout(nextRound, 1000, tableId);
    }

    broadcastGameState(tableId);
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
