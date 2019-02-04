/**
 * Actions from context-menu.
 * for example: (take, drop, pickup, etc.)
 */

import UI from 'shared/ui';
import uuid from 'uuid/v4';
import pipe from '../../pipeline';
import Action from '../../action';
import Map from '../../../core/map';
import config from '../../../config';
import Socket from '../../../socket';
import Item from '../../../core/item';
import world from '../../../core/world';
import Query from '../../../core/data/query';
import Handler from '../../../player/handler';
import Mining from '../../../core/skills/mining';
import ContextMenu from '../../../core/context-menu';
import { wearableItems, general } from '../../../core/data/items';

export default {
  'player:walk-here': (data) => {
    if (data.tileWalkable) {
      Handler['player:mouseTo']({
        data: {
          id: data.player.uuid,
          coordinates: { x: data.clickedTile.x, y: data.clickedTile.y },
        },
        player: {
          socket_id: data.player.uuid,
        },
      });
    }
  },
  /**
   * A player moves to a new tile via mouse
   */
  'player:mouseTo': async (data) => {
    const movingData = Object.hasOwnProperty.call(data, 'doing') ? data : data.data;
    const { x, y } = movingData.coordinates;

    const playerId = movingData.id || data.player.id;
    const playerIndexMoveTo = world.players.findIndex(p => p.uuid === playerId);
    const matrix = await Map.getMatrix(world.players[playerIndexMoveTo]);

    world.players[playerIndexMoveTo].path.grid = matrix;
    world.players[playerIndexMoveTo].path.current.walkable = true;

    const location = movingData.location || null;

    Map.findPath(movingData.id, x, y, location);
  },
  'player:examine': (data) => {
    Socket.emit('item:examine', {
      data: { type: 'normal', text: data.item.examine },
      player: {
        socket_id: data.player.socket_id,
      },
    });
  },
  'player:inventory-drop': (data) => {
    const itemUuid = data.player.inventory.find(s => s.slot === data.data.miscData.slot).uuid;

    const playerIndex = world.players.findIndex(p => p.uuid === data.id);
    world.players[playerIndex].inventory = world.players[playerIndex].inventory
      .filter(v => v.slot !== data.data.miscData.slot);
    Socket.broadcast('player:movement', world.players[playerIndex]);

    // Add item back to the world
    // from the grasp of the player!
    world.items.push({
      id: data.item.id,
      uuid: itemUuid,
      x: world.players[playerIndex].x,
      y: world.players[playerIndex].y,
      timestamp: Date.now(),
    });

    console.log(`Dropping: ${data.item.id} at ${world.players[playerIndex].x}, ${world.players[playerIndex].x}`);

    Socket.broadcast('world:itemDropped', world.items);
  },

  /**
   * A player equips an item from their inventory
   */
  'item:equip': async (data) => {
    const playerIndex = world.players.findIndex(p => p.uuid === data.id);
    const getItem = wearableItems.find(i => i.id === data.item.id);
    const alreadyWearing = world.players[playerIndex].wear[getItem.slot];
    if (alreadyWearing) {
      await pipe.player.unequipItem({
        item: {
          uuid: alreadyWearing.uuid,
          id: alreadyWearing.id,
          slot: data.item.miscData.slot,
        },
        replacing: true,
        id: data.id,
      });

      pipe.player.equippedAnItem(data);
    } else {
      pipe.player.equippedAnItem(data);
    }
  },

  /**
   * A player unequips an item from their wear tab
   */
  'item:unequip': (data) => {
    const itemUnequipping = data.player.wear[data.item.miscData.slot];
    const newData = Object.assign(
      data,
      {
        item: {
          id: itemUnequipping.id,
          uuid: itemUnequipping.uuid,
          slot: data.item.miscData.slot,
        },
      },
    );
    pipe.player.unequipItem(newData);
  },

  /**
   * Start building the context menu for the player
   */
  'player:context-menu:build': async (incomingData) => {
    const contextMenu = new ContextMenu(
      incomingData.data.player,
      incomingData.data.tile,
      incomingData.data.miscData,
    );

    const items = await contextMenu.build();

    Socket.emit('game:context-menu:items', {
      data: items,
      player: incomingData.data.player,
    });
  },
  'player:context-menu:action': (incoming) => {
    const miscData = incoming.data.data.item.miscData || false;
    const action = new Action(incoming.data.player.socket_id, miscData);
    action.do(incoming.data.data, incoming.data.queueItem);
  },

  'player:resource:goldenplaque:push': (data) => {
    const { playerIndex } = data;

    const { id } = UI.randomElementFromArray(wearableItems);

    world.items.push({
      id,
      uuid: uuid(),
      x: 20,
      y: 108,
      timestamp: Date.now(),
    });

    Socket.broadcast('world:itemDropped', world.items);

    Socket.emit('game:send:message', {
      player: { socket_id: world.players[playerIndex].socket_id },
      text: 'You feel a magical aurora as an item starts to appear from the ground...',
    });
  },

  'player:take': (data) => {
    const { playerIndex, todo } = data;
    // eslint-disable-next-line
    const itemToTake = world.items.findIndex(e => (e.x === todo.at.x) && (e.y === todo.at.y) && (e.uuid === todo.item.uuid));

    world.items.splice(itemToTake, 1);

    Socket.broadcast('item:change', world.items);

    console.log(`Picking up: ${todo.item.id} (${todo.item.uuid.substr(0, 5)}...)`);
    const { id } = Query.getItemData(todo.item.id);

    world.players[playerIndex].inventory.push({
      slot: UI.getOpenSlot(world.players[playerIndex].inventory),
      uuid: todo.item.uuid,
      id,
    });

    // Add respawn timer on item (if is a respawn)
    // eslint-disable-next-line
    const resetItemIndex = world.respawns.items.findIndex(i => i.respawn && i.x === todo.at.x && i.y === todo.at.y);
    if (resetItemIndex !== -1) {
      world.respawns.items[resetItemIndex].pickedUp = true;

      // eslint-disable-next-line
      world.respawns.items[resetItemIndex].willRespawnIn = Item.calculateRespawnTime(world.respawns.items[resetItemIndex].respawnIn);
    }

    // Tell client to update their inventory
    Socket.emit('core:refresh:inventory', {
      player: { socket_id: world.players[playerIndex].socket_id },
      data: world.players[playerIndex].inventory,
    });
  },

  /**
   * A player wants to access their bank
   */
  'player:screen:bank': (data) => {
    console.log('Accessing bank...');
    world.players[data.playerIndex].currentPane = 'bank';

    Socket.emit('open:screen', {
      player: { socket_id: world.players[data.playerIndex].socket_id },
      screen: 'bank',
      payload: { items: world.players[data.playerIndex].bank },
    });
  },

  /**
   * A player withdraws items from their bank
   */
  'player:screen:bank:withdraw': (data) => {
    const playerIndex = world.players.findIndex(p => p.uuid === data.id);
    const itemId = data.item.id;
    const player = world.players[playerIndex];
    let qty = data.item.params.quantity === 'All' ? player.bank.find(i => i.id === itemId).qty : data.item.params.quantity;
    const openInventorySlots = config.player.slots.inventory - player.inventory.length;
    // Is the quantity more than the slots we have available?
    qty = openInventorySlots > qty ? qty : openInventorySlots;

    // Add an item to the inventory for every quantity
    for (let index = 0; index < qty; index += 1) {
      world.players[playerIndex].inventory.push({
        id: itemId,
        uuid: uuid(),
        slot: UI.getOpenSlot(world.players[playerIndex].inventory),
      });
    }

    // Set the item that we just withdrew with its new quantity
    const itemStillInBank = player.bank.findIndex(i => i.id === itemId);
    world.players[playerIndex].bank[itemStillInBank].qty -= qty;

    // Is the quantity now zero? Let's remove it from the bank.
    if (world.players[playerIndex].bank[itemStillInBank].qty === 0) {
      world.players[playerIndex].bank.splice(itemStillInBank, 1);
    }

    // Refresh client with new data
    Socket.emit('core:refresh:inventory', {
      player: { socket_id: world.players[playerIndex].socket_id },
      data: world.players[playerIndex].inventory,
    });

    Socket.emit('core:bank:refresh', {
      player: { socket_id: world.players[playerIndex].socket_id },
      data: world.players[playerIndex].bank,
    });
  },

  /**
   * A player deposits items into their bank
   */
  'player:screen:bank:deposit': (data) => {
    const playerIndex = world.players.findIndex(p => p.uuid === data.id);
    const qty = data.item.params.quantity;
    const itemId = data.item.id;
    const player = world.players[playerIndex];
    const inv = player.inventory;
    const totalOfItemInInv = inv.filter(i => i.id === itemId).length;
    const bankItems = player.bank.map(e => e.id);

    // How many items will we keep in the inventory?
    const toKeep = totalOfItemInInv - (qty === 'All' ? totalOfItemInInv : qty);

    // Remove the first X of items we will be keeping and
    // then add remaing of inventory that we aren't depositng
    world.players[playerIndex].inventory = [
      ...inv
        .filter(i => i.id === itemId)
        .sort((a, b) => b.slot - a.slot)
        .splice(0, toKeep),
      ...inv
        .filter(i => i.id !== itemId),
    ];

    // How many items are we depositing on selection?
    const numericQty = qty === 'All' ? totalOfItemInInv : qty;

    // Do we already have items in the bank of what we're depositing?
    const itemAlreadyInBank = bankItems.includes(itemId);

    if (itemAlreadyInBank) {
      // If we do, let's just add to its quantity
      const itemFound = bankItems.findIndex(i => itemId === i);
      world.players[playerIndex].bank[itemFound].qty += numericQty;
    } else {
      // If not, let's add to their bank with the quantity
      world.players[playerIndex].bank.push({
        id: itemId,
        qty: numericQty,
        slot: UI.getOpenSlot(world.players[playerIndex].bank, 'bank'),
      });
    }

    // Refresh client with new data
    Socket.emit('core:refresh:inventory', {
      player: { socket_id: world.players[playerIndex].socket_id },
      data: world.players[playerIndex].inventory,
    });

    Socket.emit('core:bank:refresh', {
      player: { socket_id: world.players[playerIndex].socket_id },
      data: world.players[playerIndex].bank,
    });
  },

  /**
   * A player is going to attempt to mine a rock
   */
  'player:resource:mining:rock': async (data) => {
    const mining = new Mining(data.playerIndex, data.todo.item.id);

    // Update rock to dead-rock after successful mine
    world.map.foreground[data.todo.actionToQueue.onTile] = 532;

    try {
      const rockMined = await mining.pickAtRock();
      const resource = general.find(i => i.id === rockMined.resources);

      // Tell user of successful resource gathering
      Socket.sendMessageToPlayer(data.playerIndex, `You successfully mined some ${resource.name}.`);

      // Extract resource and either add to inventory or drop it
      mining.extractResource(resource);

      // Update the experience
      mining.updateExperience(rockMined.experience);

      // Tell client of their new experience in that skill
      Socket.emit('resource:skills:update', {
        player: { socket_id: world.players[data.playerIndex].socket_id },
        data: world.players[data.playerIndex].skills,
      });

      // Update client of dead rock
      Socket.broadcast('world:foreground:update', world.map.foreground);

      // Add this resource to respawn clock
      world.respawns.resources.push({
        setToTile: rockMined.id + 253,
        onTile: data.todo.actionToQueue.onTile,
        willRespawnIn: Item.calculateRespawnTime(rockMined.respawnIn),
      });
    } catch (err) {
      // Tell player of their error
      // either no pickaxe or no rock available
      Socket.sendMessageToPlayer(data.playerIndex, err.message);
    }
  },
};
