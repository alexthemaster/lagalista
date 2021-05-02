import express from 'express';
import inquirer from 'inquirer';
import fetch from 'node-fetch';
import spotify from 'spotify-web-api-node';
import pqueue from 'p-queue';
import { writeFile, readFile, stat } from 'fs/promises';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

class Lagalista {
    constructor() {
        this.server = express();
        // Callback for logging into Deezer
        this.server.get('/callback', async (req, res) => {
            const code = req.query.code;
            if (!code) {
                console.error("It looks like you didn't authorize the application on Deezer.com, aborting...");
                process.exit(1);
            };

            const fetched = await fetch(`https://connect.deezer.com/oauth/access_token.php?app_id=${this.config['deezerAppID']}&secret=${this.config['deezerSecretKey']}&code=${code}`).then(res => res.text());
            const access_token = fetched.split('=')[1].split('&e')[0];
            this.deezerAccessToken = access_token;
            res.end('Successfully logged in! You can now return to your console.');
        });

        this.spotify = null;

        this.server.listen(8080, () => console.log(`Web server started on port 8080`));
        this.deezerAccessToken = null;

        this.configPath = join(dirname(fileURLToPath(import.meta.url)), 'config.json');
        this.config = null;

        this.queue = new pqueue({ interval: 5000, intervalCap: 50 });

        this.loadConfig().then(() => this.actions());
    }

    async createConfig() {
        const { spotifyClientID, spotifySecret, deezerAppID, deezerSecretKey } = await inquirer.prompt([
            {
                name: 'spotifyClientID',
                message: 'What is your Spotify app id?'
            },
            {
                name: 'spotifySecret',
                message: 'What is your Spotify client secret?'
            },
            {
                name: 'deezerAppID',
                message: 'What is your Deezer app id?',
                validate: (input) => !isNaN(input) ? true : 'Please input your application ID (should be a number)'
            }, {
                name: 'deezerSecretKey',
                message: 'What is your Deezer secret key?'
            }]);

        this.config = { spotifyClientID, spotifySecret, deezerAppID, deezerSecretKey, playlists: [] };
        await this.saveConfig();
        return;
    }

    async saveConfig() {
        await writeFile(this.configPath, JSON.stringify(this.config));
        return;
    }

    async loadConfig() {
        await stat(this.configPath).catch(async err => {
            if (err.code !== 'ENOENT') { console.log('Something went wrong while reading the config file.'); process.exit(1) };
            console.log(`There doesn't seem to be a config file available, creating one...`);
            await this.createConfig();
        });

        if (!this.config) this.config = await readFile(this.configPath).then(buffer => JSON.parse(buffer));

        this.spotify = new spotify({
            clientId: this.config['spotifyClientID'],
            clientSecret: this.config['spotifySecret']
        });

        const { body: { access_token } } = await this.spotify.clientCredentialsGrant();
        this.spotify.setAccessToken(access_token);

        return;
    }

    async addPlaylist() {
        const { spotifyPlaylist, deezerPlaylist } = await inquirer.prompt([{
            name: 'spotifyPlaylist',
            message: 'What is the ID of the Spotify playlist?'
        },
        {
            name: 'deezerPlaylist',
            message: 'What is the ID of the Deezer playlist equivalent to the Spotify playlist?'
        }]);

        this.config['playlists'].push({ spotifyPlaylist, deezerPlaylist });
        await this.saveConfig();
        return;
    }

    async getCurrentTracks(id) {
        const currentTracks = [];
        let toFetch = `https://api.deezer.com/playlist/${id}/tracks?access_token=${this.deezerAccessToken}`;
        let loop = true;

        while (loop) {
            await this.queue.add(async () => {
                const { data, next } = await fetch(toFetch).then(res => res.json()).catch(console.error);
                if (!next) loop = false;
                toFetch = next;
                const tracks = data.map(track => track.id);
                currentTracks.push(...tracks);
            })
        }

        return currentTracks;
    }

    async addToDeezer(id, tracks) {
        const ids = [];

        for (const track of tracks) {
            const artist = track.track.artists[0].name;
            const name = track.track.name;
            const length = track.duration_ms / 1000;

            await this.queue.add(async () => {
                const res = await fetch(`https://api.deezer.com/search?q=artist:"${encodeURI(artist.toLowerCase())}" track:"${encodeURI(name.toLowerCase())}" dur_max:${encodeURI(length + 1)}`).then(res => res.json()).catch(console.error);
                if (!res.data[0]) return;
                else ids.push(res.data[0].id);
            });
        }

        const currentTracks = await this.getCurrentTracks(id);
        const toAdd = [...new Set(ids)].filter(item => !currentTracks.includes(item));
        await fetch(`https://api.deezer.com/playlist/${id}/tracks?access_token=${this.deezerAccessToken}&songs=${toAdd.join(',')}`, { method: 'POST' }).catch(console.error);
        console.log(`Successfully updated the ${id} Deezer playlist!`);
    };

    async getSpotifyTracks(id) {
        const tracks = [];
        let next = true;
        let offset = 0;

        while (next) {
            const { body: { items, next: nextURL } } = await this.spotify.getPlaylistTracks(id, { offset })
            if (!nextURL) next = false;
            else offset = nextURL.split('offset=')[1].split('&')[0];
            tracks.push(...items)
        }

        return tracks;
    }

    async convert() {
        if (!this.config['playlists'].length) {
            console.log("Can't convert because there aren't any playlists available. Please add some!");
            return this.actions();
        };

        if (!this.deezerAccessToken) {
            console.log(`Please log into Deezer using the following URL and then re - select this action: https://connect.deezer.com/oauth/auth.php?app_id=${this.config['deezerAppID']}&redirect_uri=http://localhost:8080/callback&perms=manage_library \n`);
            return this.actions();
        }

        console.log('WARNING: Deezer has an API limit of 50 interactions / 5 seconds therefore this process could take some time.')

        for (const item of this.config['playlists']) {
            const spotifyID = item.spotifyPlaylist;
            const deezerID = item.deezerPlaylist;
            const { statusCode, body: { name } } = await this.spotify.getPlaylist(spotifyID);
            if (statusCode === 404) {
                console.log(`Spotify playlist with the ID of ${spotifyID} not found, skipping...`)
                continue;
            }

            const tracks = await this.getSpotifyTracks(spotifyID);
            console.log(`Found ${tracks.length} tracks in the Spotify playlist called ${name}, adding them to Deezer!`);

            await this.addToDeezer(deezerID, tracks);
            process.exit(0);
        }
    };

    async actions() {
        const { choice } = await inquirer.prompt([{
            name: 'choice',
            message: "Choose what action you want to do",
            type: 'list',
            choices: ['Convert playlists', 'Show config', 'Re-make config', 'Add playlist', 'Delete last playlist', 'Exit']
        }]);

        switch (choice) {
            case 'Convert playlists':
                this.convert();
                break;
            case 'Show config':
                console.log(this.config);
                this.actions();
                break;

            case 'Re-make config':
                await this.createConfig();
                console.log('Successfully re-made the config file');
                this.actions();
                break;

            case 'Add playlist':
                await this.addPlaylist();
                console.log('Successfully added a new playlist!');
                this.actions();
                break;
            case 'Delete last playlist':
                this.config['playlists'].pop();
                await this.saveConfig();
                console.log('Successfully removed the last playlist');
                this.actions();
                break;

            case 'Exit':
                process.exit(0);
                break;
            default: null;
        }
    }
}

new Lagalista();
