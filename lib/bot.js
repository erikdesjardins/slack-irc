import _ from 'lodash';
import irc from 'irc';
import logger from 'winston';
import Slack from 'slack-client';
import { ConfigurationError } from './errors';
import emojis from '../assets/emoji.json';
import { validateChannelMapping } from './validators';
import { highlightUsername } from './helpers';

const ALLOWED_SUBTYPES = ['me_message'];
const REQUIRED_FIELDS = ['server', 'nickname', 'slackUser', 'channelMapping', 'token'];

/**
 * An IRC bot, works as a middleman for all communication
 * @param {object} options
 */
class Bot {
  constructor(options) {
    REQUIRED_FIELDS.forEach(field => {
      if (!options[field]) {
        throw new ConfigurationError('Missing configuration field ' + field);
      }
    });

    validateChannelMapping(options.channelMapping);

    this.slack = new Slack(options.token);

    this.server = options.server;
    this.nickname = options.nickname;
    this.slackUser = options.slackUser;
    this.ircOptions = options.ircOptions;
    this.ircStatusNotices = options.ircStatusNotices || {};
    this.channels = _.values(options.channelMapping);

    this.rememberRecipientsFor = +(options.rememberRecipientsFor || 1000 * 60 * 10);
    this.lastPM = {
      user: '',
      timestamp: 0
    };

    this.channelMapping = {};

    // Remove channel passwords from the mapping and lowercase IRC channel names
    _.forOwn(options.channelMapping, (ircChan, slackChan) => {
      this.channelMapping[slackChan] = ircChan.split(' ')[0].toLowerCase();
    }, this);

    this.invertedMapping = _.invert(this.channelMapping);
    this.autoSendCommands = options.autoSendCommands || [];
  }

  connect() {
    logger.debug('Connecting to IRC and Slack');
    this.slack.login();

    const ircOptions = {
      userName: this.nickname,
      realName: this.nickname,
      channels: this.channels,
      floodProtection: true,
      floodProtectionDelay: 500,
      ...this.ircOptions
    };

    this.ircClient = new irc.Client(this.server, this.nickname, ircOptions);
    this.attachListeners();
  }

  attachListeners() {
    this.slack.on('open', () => {
      logger.debug('Connected to Slack');
    });

    this.ircClient.on('registered', message => {
      logger.debug('Registered event: ', message);
      this.autoSendCommands.forEach(element => {
        this.ircClient.send(...element);
      });
    });

    this.ircClient.on('error', error => {
      logger.error('Received error event from IRC', error);
      this.sendToSlack(false, this.nickname, `_${error.command}_ : _${error.args.join(' ')}_`);
    });

    this.slack.on('error', error => {
      logger.error('Received error event from Slack', error);
    });

    this.slack.on('presenceChange', (user, presence) => {
      if (user.name === this.slackUser) {
        if (presence === 'active') {
          this.ircClient.send('AWAY');
        } else {
          this.ircClient.send('AWAY', ' ');
        }
      }
    });

    this.slack.on('message', message => {
      // Ignore everything except the desired Slack user
      const user = this.slack.getUserByID(message.user);
      if (user && user.name === this.slackUser && message.type === 'message' &&
        (!message.subtype || ALLOWED_SUBTYPES.indexOf(message.subtype) > -1)) {
        this.sendToIRC(message);
      }
    });

    this.ircClient.on('message', this.sendToSlack.bind(this));

    this.ircClient.on('notice', (author, to, text) => {
      const formattedText = '*' + text + '*';
      this.sendToSlack(author, to, formattedText);
    });

    this.ircClient.on('action', (author, to, text) => {
      const formattedText = '_' + text + '_';
      this.sendToSlack(author, to, formattedText);
    });

    this.ircClient.on('topic', (channel, topic, nick) => {
      this.sendToSlack(false, channel, `*${nick}* has changed the topic to: *${topic}*`);
    });

    this.ircClient.on('kick', (channel, nick, by, reason) => {
      this.sendToSlack(false, channel, `*${by}* has kicked *${nick}* (_${reason}_)`);
    });

    this.ircClient.on('kill', (nick, reason, channels) => {
      channels.forEach(channel => {
        this.sendToSlack(false, channel, `*${nick}* has been killed (_${reason}_)`);
      });
    });

    this.ircClient.on('invite', (channel, from) => {
      logger.debug('Received invite:', channel, from);
      if (!this.invertedMapping[channel]) {
        logger.debug('Channel not found in config, not joining:', channel);
      } else {
        this.ircClient.join(channel);
        logger.debug('Joining channel:', channel);
      }
    });

    this.ircClient.on('whois', (info) => {
      const date = new Date(Date.now() - info.idle * 1000);
      this.sendToSlack(false, this.nickname, [
        `WHOIS for *${info.nick}*`,
        `(_${info.user}@${info.host}_): _${info.realname}_`,
        `_${info.server}_ :_${info.serverinfo}_`,
        info.account && `${info.accountinfo} _${info.account}_`,
        info.away && `is away (_${info.away}_)`,
        info.idle && `idle since _${date.toDateString()}, ${date.toLocaleTimeString()}_`
      ].filter(s => s).join('\r\n'));
    });

    if (this.ircStatusNotices.join) {
      this.ircClient.on('join', (channel, nick) => {
        if (nick !== this.nickname) {
          this.sendToSlack(false, channel, `*${nick}* has joined`);
        }
      });
    }

    if (this.ircStatusNotices.leave) {
      this.ircClient.on('part', (channel, nick, reason) => {
        this.sendToSlack(false, channel, `*${nick}* has left (_${reason}_)`);
      });

      this.ircClient.on('quit', (nick, reason, channels) => {
        channels.forEach(channel => {
          this.sendToSlack(false, channel, `*${nick}* has quit (_${reason}_)`);
        });
      });
    }

    if (this.ircStatusNotices.changeNick) {
      this.ircClient.on('nick', (oldNick, newNick, channels) => {
        channels.forEach(channel => {
          this.sendToSlack(false, channel, `*${oldNick}* is now known as *${newNick}*`);
        });
      });
    }

    if (this.ircStatusNotices.modes) {
      this.ircClient.on('+mode', (channel, by, mode, arg) => {
        this.sendToSlack(false, channel, `*${by}* sets mode *+${mode}* on _${arg || channel}_`);
      });
      this.ircClient.on('-mode', (channel, by, mode, arg) => {
        this.sendToSlack(false, channel, `*${by}* sets mode *-${mode}* on _${arg || channel}_`);
      });
    }
  }

  parseText(text) {
    return text
      .replace(/\n|\r\n|\r/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/<!channel>/g, '@channel')
      .replace(/<!group>/g, '@group')
      .replace(/<!everyone>/g, '@everyone')
      .replace(/<#(C\w+)\|?(\w+)?>/g, (match, channelId, readable) => {
        const { name } = this.slack.getChannelByID(channelId);
        return readable || `#${name}`;
      })
      .replace(/<@(U\w+)\|?(\w+)?>/g, (match, userId, readable) => {
        const { name } = this.slack.getUserByID(userId);
        return readable || `@${name}`;
      })
      .replace(/<(?!!)(\S+)>/g, (match, link) => link)
      .replace(/<!(\w+)\|?(\w+)?>/g, (match, command, label) =>
        `<${label || command}>`
      )
      .replace(/\:(\w+)\:/g, (match, emoji) => {
        if (emoji in emojis) {
          return emojis[emoji];
        }

        return match;
      });
  }

  sendDMToIRC(text, channel) {
    const pmMatch = (/^(\S+):\s+(.+)/i).exec(text);

    if (pmMatch) {
      const [, user, msg] = pmMatch;
      logger.debug('Sending /msg to IRC user', user, msg);
      this.ircClient.send('PRIVMSG', user, msg);
      this.lastPM.user = user;
      this.lastPM.timestamp = Date.now();
      return;
    }

    const lastMessage = Date.now() - this.lastPM.timestamp;
    if (lastMessage < this.rememberRecipientsFor) {
      const user = this.lastPM.user;
      logger.debug('Sending /msg to last messaged IRC user', user, text);
      this.ircClient.send('PRIVMSG', user, text);
      this.lastPM.user = user;
      this.lastPM.timestamp = Date.now();
      return;
    }

    if (this.lastPM.user) {
      logger.debug('Not sending message', text, 'since user', this.lastPM.user, 'was messaged',
          lastMessage, 'ago, which is more than', this.rememberRecipientsFor);
      channel.send(`_it's been too long since your last message, please specify the user_`);
      return;
    }

    logger.debug('Not sending message', text, 'since no users have been messaged');
    channel.send(`_you haven't messaged anyone yet, please specify the user_`);
  }

  sendToIRC(message) {
    const channel = this.slack.getChannelGroupOrDMByID(message.channel);
    if (!channel) {
      logger.info('Received message from a channel the bot isn\'t in:',
        message.channel);
      return;
    }

    let text = this.parseText(message.getBody());
    const cmdMatch = (/^[A-Z]+\s\S/).test(text);

    if (cmdMatch) {
      logger.debug('Sending raw command to IRC', text);
      this.ircClient.send(...text.split(' '));
      channel.send(`_sent raw command_`);
      return;
    }

    if (channel.is_im) {
      this.sendDMToIRC(text, channel);
      return;
    }

    const channelName = channel.is_channel ? `#${channel.name}` : channel.name;
    const ircChannel = this.channelMapping[channelName];

    logger.debug('Channel Mapping', channelName, this.channelMapping[channelName]);
    if (ircChannel) {
      if (message.subtype === 'me_message') {
        text = `\x01ACTION ${text}\x01`;
      }
      logger.debug('Sending message to IRC', channelName, text);
      this.ircClient.say(ircChannel, text);
    }
  }

  sendToSlack(author, channel, text) {
    const slackChannelName = channel === this.nickname ?
        this.slackUser :
        this.invertedMapping[channel.toLowerCase()];
    if (slackChannelName) {
      const slackChannel = this.slack.getChannelGroupOrDMByName(slackChannelName);

      // If it's a private group and the bot isn't in it, we won't find anything here.
      // If it's a channel however, we need to check is_member.
      if (!slackChannel ||
          (!slackChannel.is_member && !slackChannel.is_group && !slackChannel.is_im)) {
        logger.info('Tried to send a message to a channel the bot isn\'t in:', slackChannelName);
        return;
      }

      const currentChannelUsernames = (slackChannel.members || []).map(member =>
        this.slack.getUserByID(member).name
      );

      const mappedText = currentChannelUsernames.reduce((current, username) =>
        highlightUsername(username, current)
      , text);

      logger.debug('Sending message to Slack', mappedText, channel, '->', slackChannelName);
      if (author) {
        slackChannel.postMessage({
          text: mappedText,
          username: author,
          parse: 'full',
          icon_url: `http://api.adorable.io/avatars/48/${author}.png`
        });
      } else {
        slackChannel.send(mappedText);
      }
    }
  }
}

export default Bot;
